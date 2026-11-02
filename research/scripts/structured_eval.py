"""Run the Structured prompt through gateway models on saved STT transcripts.

OpenAI-compatible, non-streaming (the shipping app is non-streaming). Records
total latency, usage, finish reason and repeat runs for stability.

Usage:
  python structured_eval.py --corpus ../corpus/structured_scripts.json --source structured_raw_a \
      --models gemma-4-31b --tag s_v1 --runs 2
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

from common import ENV, FINAL, OUT, sanitize_transcript

GATEWAY = "https://llm-gateway.assemblyai.com/v1"


def load_prompt(path: Path, data: dict, app_name: str) -> str:
    """Load the Structured prompt and fill it the way build_system_prompt does.

    Drops a leading Markdown title and substitutes the dictionary, known names,
    app name and transcript placeholder.
    """
    text = path.read_text(encoding="utf-8")
    # Match build_system_prompt: strip a leading Markdown title line.
    text = text.removeprefix("﻿")
    trimmed = text.lstrip("\r\n")
    if trimmed.startswith("#"):
        newline = trimmed.find("\n")
        text = trimmed[newline + 1 :].lstrip("\r\n") if newline >= 0 else ""
    else:
        text = trimmed

    def dumps(value) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    return (
        text.replace("{{DICTIONARY}}", dumps(data["dictionary"]))
        .replace("{{KNOWN_NAMES}}", dumps(data["builtin_names"]))
        .replace("{{APP_NAME}}", dumps(app_name))
        .replace("{{TRANSCRIPT}}", "(the transcript)")
    )


def normalize(text: str) -> list[str]:
    """Lowercase word tokens used to compare repeat runs."""
    return re.findall(r"[a-z0-9]+", text.lower())


def call(model: str, system: str, user: str, temperature: float, max_tokens: int, timeout: float) -> dict:
    """POST one non-streaming completion, retrying 429s, and record its latency."""
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    request = urllib.request.Request(
        GATEWAY + "/chat/completions",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {ENV['ASSEMBLYAI_API_KEY']}",
            "Content-Type": "application/json",
            "User-Agent": "RayDictationResearch/1.0",
        },
        method="POST",
    )
    for attempt in range(5):
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = json.loads(response.read())
            choice = (body.get("choices") or [{}])[0]
            message = choice.get("message") or {}
            content = message.get("content") or ""
            return {
                "ok": bool(content.strip()),
                "text": content.strip(),
                "total_ms": round((time.perf_counter() - started) * 1000, 1),
                "finish_reason": choice.get("finish_reason"),
                "usage": body.get("usage") or {},
                "attempts": attempt + 1,
                "error": None if content.strip() else f"empty content (finish_reason={choice.get('finish_reason')})",
            }
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            if error.code == 429 and attempt < 4:
                retry_after = error.headers.get("retry-after")
                try:
                    delay = float(retry_after) if retry_after else 10.0 * (attempt + 1)
                except ValueError:
                    delay = 10.0 * (attempt + 1)
                time.sleep(max(2.0, delay))
                continue
            return {"ok": False, "text": "", "total_ms": round((time.perf_counter() - started) * 1000, 1), "attempts": attempt + 1, "error": f"HTTP {error.code}: {detail[:400]}"}
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
            return {"ok": False, "text": "", "total_ms": round((time.perf_counter() - started) * 1000, 1), "attempts": attempt + 1, "error": f"network error: {error}"}
    return {"ok": False, "text": "", "total_ms": 0, "attempts": 5, "error": "no attempt succeeded"}


def main() -> None:
    """Run each requested model over the corpus and merge results per tag/model."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", required=True)
    parser.add_argument("--source", required=True, help="STT JSON filename under out/stt")
    parser.add_argument("--models", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--prompt", default=str(FINAL / "structured_system_prompt.md"))
    parser.add_argument("--ids")
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--max-tokens", type=int, default=3000)
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--sleep", type=float, default=2.1, help="seconds between requests (gateway 30 rpm/model)")
    parser.add_argument("--app-name", default="(unknown)")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    data = json.loads(Path(args.corpus).read_text(encoding="utf-8"))
    system = load_prompt(Path(args.prompt), data, args.app_name)
    source_name = args.source if args.source.endswith(".json") else args.source + ".json"
    stt = json.loads((OUT / "stt" / source_name).read_text(encoding="utf-8"))
    ids = [s["id"] for s in data["scripts"] if s["id"] in stt]
    if args.ids:
        wanted = set(args.ids.split(","))
        ids = [sid for sid in ids if sid in wanted]

    out_dir = OUT / "llm"
    out_dir.mkdir(parents=True, exist_ok=True)
    for model in args.models.split(","):
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", model)
        path = out_dir / f"{args.tag}__{safe}.json"
        results = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        for sid in ids:
            if not args.force and (results.get(sid) or {}).get("ok"):
                continue
            transcript = sanitize_transcript(stt[sid].get("text") or "")
            if not transcript:
                continue
            user = f"<transcript>\n{transcript}\n</transcript>"
            runs = []
            for _ in range(max(1, args.runs)):
                runs.append(call(model, system, user, args.temperature, args.max_tokens, args.timeout))
                if args.sleep:
                    time.sleep(args.sleep)
            first = runs[0]
            ok_runs = [r for r in runs if r["ok"]]
            stable = None
            if len(ok_runs) >= 2:
                a = normalize(ok_runs[0]["text"])
                b = normalize(ok_runs[1]["text"])
                stable = round(difflib.SequenceMatcher(None, a, b).ratio(), 3)
            record = {
                "ok": first["ok"],
                "text": first["text"],
                "total_ms": first["total_ms"],
                "ttft_ms": None,
                "finish_reason": first.get("finish_reason"),
                "usage": first.get("usage") or {},
                "error": first.get("error"),
                "transcript": transcript,
                "model": model,
                "runs": runs,
                "run_stability": stable,
            }
            results[sid] = record
            path.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
            flag = "ok " if first["ok"] else "ERR"
            print(f"{model:<26} {sid:<28} {flag} {first['total_ms']:7.0f}ms stable={stable} {first['text'][:70]!r}")
            if not first["ok"]:
                print("   ", first.get("error"))
        print(f"-> {path.name}: {sum(1 for r in results.values() if r.get('ok'))}/{len(ids)} ok")


if __name__ == "__main__":
    main()
