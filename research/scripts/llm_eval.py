"""Run raw transcripts through cleanup models on the AssemblyAI LLM Gateway.

OpenAI-compatible. Measures time-to-first-token (streaming) and total latency,
saves per-model outputs.

Usage:
  python llm_eval.py --provider aai --models gemma-4-31b --tag v4
"""
from __future__ import annotations

import argparse
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

from common import ENV, FINAL, OUT, corpus

PROVIDERS = {
    "aai": ("https://llm-gateway.assemblyai.com/v1", "ASSEMBLYAI_API_KEY"),
}

MAX_TOKENS = 1500


def load_prompt() -> str:
    text = (FINAL / "cleanup_system_prompt.md").read_text(encoding="utf-8")
    # Drop the markdown title line; keep everything else.
    text = re.sub(r"^#.*\n", "", text).strip()
    data = corpus()
    # Match the app: reference data is JSON (serde_json has no spaces after
    # separators) so it can never break out of its literal.
    def dumps(value) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    names = dumps(data["dictionary"])
    known = dumps(data["builtin_names"])
    return (
        text.replace("{{DICTIONARY}}", names)
        .replace("{{KNOWN_NAMES}}", known)
        .replace("{{APP_NAME}}", dumps("(unknown)"))
    )


def stream_chat(base: str, key: str, model: str, system: str, user: str, temperature: float = 0.0, retries: int = 0, reasoning: str | None = None) -> dict:
    payload = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": temperature,
        "max_tokens": MAX_TOKENS,
        "stream": True,
    }
    if reasoning:
        payload["reasoning_effort"] = reasoning
    req = urllib.request.Request(
        base + "/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": "RayDictationResearch/1.0"},
        method="POST",
    )
    t0 = time.perf_counter()
    ttft = None
    chunks: list[str] = []
    usage = {}
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except Exception:
                    continue
                if obj.get("usage"):
                    usage = obj["usage"]
                delta = (obj.get("choices") or [{}])[0].get("delta", {}).get("content")
                if delta:
                    if ttft is None:
                        ttft = time.perf_counter() - t0
                    chunks.append(delta)
        return {"ok": True, "text": "".join(chunks), "ttft_ms": round((ttft or 0) * 1000, 1), "total_ms": round((time.perf_counter() - t0) * 1000, 1), "usage": usage}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        if e.code == 429 and retries < 3:
            time.sleep(2.0 * (retries + 1))
            return stream_chat(base, key, model, system, user, temperature, retries + 1, reasoning)
        return {"ok": False, "error": f"HTTP {e.code}: {body[:400]}", "total_ms": round((time.perf_counter() - t0) * 1000, 1)}
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
        return {"ok": False, "error": f"network error: {e}", "total_ms": round((time.perf_counter() - t0) * 1000, 1)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", required=True, choices=PROVIDERS)
    ap.add_argument("--models", required=True)
    ap.add_argument("--source", default="../out/stt/sync_raw.json", help="STT output json to use as transcripts")
    ap.add_argument("--tag", required=True)
    ap.add_argument("--ids")
    ap.add_argument("--reasoning-effort", choices=["low", "medium", "high"])
    ap.add_argument("--extra", help="optional extra label suffix")
    args = ap.parse_args()

    base, keyname = PROVIDERS[args.provider]
    key = ENV[keyname]
    system = load_prompt()
    stt = json.loads((OUT / "stt" / Path(args.source).name).read_text(encoding="utf-8"))
    data = {s["id"]: s for s in corpus()["scripts"]}
    ids = list(stt)
    if args.ids:
        ids = [i for i in ids if i in set(args.ids.split(","))]

    outdir = OUT / "llm"
    outdir.mkdir(parents=True, exist_ok=True)
    for model in args.models.split(","):
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", model)
        model_tag = f"{args.tag}__{safe}" + (f"__{args.extra}" if args.extra else "")
        results = {}
        for sid in ids:
            transcript = stt[sid].get("text") or ""
            user = f"<transcript>\n{transcript}\n</transcript>"
            r = stream_chat(base, key, model, system, user, reasoning=args.reasoning_effort)
            r["transcript"] = transcript
            results[sid] = r
            flag = "ok " if r["ok"] else "ERR"
            print(f"{model:<38} {sid:<24} {flag} ttft={r.get('ttft_ms')}ms total={r['total_ms']}ms")
            if not r["ok"]:
                print("   ", r["error"])
            (outdir / f"{model_tag}.json").write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
            time.sleep(0.4)
        print(f"-> {model_tag} done ({len(results)} clips)")


if __name__ == "__main__":
    main()
