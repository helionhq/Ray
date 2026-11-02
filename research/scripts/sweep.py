"""Compare cleanup models on the regression corpus + the round-2 hard corpus.

Uses the final prompt, non-streaming (the shipping app does not stream), and
records total latency, token usage and errors. Requests are paced for the
AssemblyAI gateway's 30 requests/minute/model limit.

Usage:
  python sweep.py --provider aai --tag v7 --models gemma-4-31b,qwen3.5-4b-32k-fast --sleep 2.2
"""
from __future__ import annotations

import argparse
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

from common import ENV, FINAL, OUT

PROVIDERS = {
    "aai": ("https://llm-gateway.assemblyai.com/v1", "ASSEMBLYAI_API_KEY"),
}
MAX_TOKENS = 3000


def load_prompt() -> str:
    text = (FINAL / "cleanup_system_prompt.md").read_text(encoding="utf-8")
    text = re.sub(r"^#.*\n", "", text).strip()
    dictionary = ["Arham", "Helion", "Ray"]
    known = [
        "Claude", "ChatGPT", "GPT-5", "Gemma", "gpt-oss", "Grok", "Groq",
        "Gemini", "Anthropic", "OpenAI", "Vercel", "Tauri", "Supabase", "Linear",
        "Notion", "Kubernetes", "PostgreSQL", "Next.js", "shadcn", "Tailwind",
        "TypeScript", "GitHub", "Slack", "Deepgram", "AssemblyAI", "Typeless",
        "Rust", "pnpm",
    ]
    # Match the app: reference data is JSON (serde_json has no spaces after
    # separators) so it can never break out of its literal.
    def dumps(value) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    return (
        text.replace("{{DICTIONARY}}", dumps(dictionary))
        .replace("{{KNOWN_NAMES}}", dumps(known))
        .replace("{{APP_NAME}}", dumps("(unknown)"))
    )


def corpus_ids() -> tuple[list[str], list[str]]:
    old: list[str] = []
    hard: list[str] = []
    for name, target in (("scripts.json", old), ("hard_scripts.json", hard)):
        data = json.loads((Path(__file__).resolve().parents[1] / "corpus" / name).read_text(encoding="utf-8"))
        target.extend(script["id"] for script in data["scripts"])
    return old, hard


def transcripts(old_source: str, hard_source: str) -> dict[str, str]:
    old = json.loads((OUT / "stt" / old_source).read_text(encoding="utf-8"))
    hard = json.loads((OUT / "stt" / hard_source).read_text(encoding="utf-8"))
    merged: dict[str, str] = {}
    for source in (old, hard):
        for sid, record in source.items():
            text = (record.get("text") or "").strip()
            if text:
                merged[sid] = text
    return merged


def call(
    base: str,
    key: str,
    model: str,
    system: str,
    user: str,
    reasoning: str | None,
    retries: int = 5,
) -> dict:
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0,
        "max_tokens": MAX_TOKENS,
        "stream": False,
    }
    if reasoning:
        payload["reasoning_effort"] = reasoning
    request = urllib.request.Request(
        base + "/chat/completions",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "User-Agent": "RayDictationResearch/1.0",
        },
        method="POST",
    )
    started = time.perf_counter()
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                body = json.loads(response.read())
            choices = body.get("choices") or [{}]
            text = (choices[0].get("message") or {}).get("content") or ""
            return {
                "ok": bool(text.strip()),
                "text": text.strip(),
                "total_ms": round((time.perf_counter() - started) * 1000, 1),
                "usage": body.get("usage") or {},
            }
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            if error.code == 429 and attempt < retries:
                retry_after = error.headers.get("retry-after")
                try:
                    delay = float(retry_after) if retry_after else 10.0 * (attempt + 1)
                except ValueError:
                    delay = 10.0 * (attempt + 1)
                print(f"   429, sleeping {delay:.0f}s: {detail[:120]}")
                time.sleep(delay)
                continue
            return {
                "ok": False,
                "error": f"HTTP {error.code}: {detail[:400]}",
                "total_ms": round((time.perf_counter() - started) * 1000, 1),
            }
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
            return {
                "ok": False,
                "error": f"network error: {error}",
                "total_ms": round((time.perf_counter() - started) * 1000, 1),
            }
    return {"ok": False, "error": "no attempt succeeded", "total_ms": 0}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", required=True, choices=PROVIDERS)
    parser.add_argument("--models", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--old-source", default="app_final.json")
    parser.add_argument("--hard-source", default="hard_merged.json")
    parser.add_argument("--ids", help="comma-separated ids (default: old + hard)")
    parser.add_argument("--split", choices=["both", "old", "hard"], default="both")
    parser.add_argument("--corpus", help="corpus JSON whose ids to run (default: built-in corpora)")
    parser.add_argument("--sleep", type=float, default=0)
    parser.add_argument("--force", action="store_true", help="re-run ids that already succeeded")
    parser.add_argument("--reasoning-effort", choices=["low", "medium", "high"])
    args = parser.parse_args()

    base, key_name = PROVIDERS[args.provider]
    key = ENV[key_name]
    system = load_prompt()
    old_ids, hard_ids = corpus_ids()
    if args.corpus:
        data = json.loads(Path(args.corpus).read_text(encoding="utf-8"))
        wanted = {script["id"] for script in data["scripts"]}
    elif args.split == "old":
        wanted = set(old_ids)
    elif args.split == "hard":
        wanted = set(hard_ids)
    else:
        wanted = set(old_ids) | set(hard_ids)
    if args.ids:
        wanted &= set(args.ids.split(","))
    sources = transcripts(args.old_source, args.hard_source)
    ids = [sid for sid in sources if sid in wanted]

    out_dir = OUT / "llm"
    for model in args.models.split(","):
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", model)
        path = out_dir / f"{args.tag}__{safe}.json"
        results = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        for sid in ids:
            if not args.force and (results.get(sid) or {}).get("ok"):
                continue
            transcript = sources[sid]
            user = f"<transcript>\n{transcript}\n</transcript>"
            record = call(base, key, model, system, user, args.reasoning_effort)
            record["transcript"] = transcript
            results[sid] = record
            path.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
            flag = "ok " if record["ok"] else "ERR"
            print(f"{model:<32} {sid:<26} {flag} {record['total_ms']}ms")
            if not record["ok"]:
                print("   ", record.get("error"))
            if args.sleep:
                time.sleep(args.sleep)
        print(f"-> {path.name}: {sum(1 for r in results.values() if r.get('ok'))}/{len(ids)} ok")


if __name__ == "__main__":
    main()
