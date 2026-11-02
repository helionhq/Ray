"""Transcribe the Structured-mode corpora with the app's STT configuration.

Uses the same Sync batch endpoint, model and config the app sends (prompt +
keyterms from src-tauri/config/pipeline.json, user dictionary first). Batch is
an acceptable stand-in for the live path in the research loop.

Usage:
  python structured_stt.py --corpus ../corpus/structured_scripts.json --tag structured_raw_a
  python structured_stt.py --corpus ../corpus/structured_heldout_scripts.json --tag structured_heldout_a
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from common import AUDIO, ENV, OUT, RESEARCH, http_multipart, wav_duration

PIPELINE = RESEARCH.parent / "src-tauri" / "config" / "pipeline.json"
SYNC_BATCH = "https://sync.assemblyai.com/v1/transcribe"


def app_stt_config(corpus: dict) -> tuple[str, list[str], str]:
    pipeline = json.loads(PIPELINE.read_text(encoding="utf-8"))
    stt = pipeline["stt"]
    prompt = stt["prompt"]
    limit = int(stt.get("keyterms_limit", 100))
    terms: list[str] = []
    for term in corpus["dictionary"] + corpus["builtin_names"] + pipeline.get("known_names", []):
        if term and term not in terms:
            terms.append(term)
    terms = terms[:limit]
    model = stt.get("sync_live", {}).get("model") or stt.get("batch", {}).get("model")
    return prompt, terms, model


def transcribe(path: Path, prompt: str, terms: list[str], model: str) -> dict:
    config = {"prompt": prompt, "keyterms_prompt": terms}
    fields = {
        "config": ("", json.dumps(config).encode(), "application/json"),
        "audio": (path.name, path.read_bytes(), "audio/wav"),
    }
    status, body, meta = http_multipart(
        SYNC_BATCH,
        fields,
        headers={"Authorization": ENV["ASSEMBLYAI_API_KEY"], "X-AAI-Model": model},
        timeout=300,
    )
    return {
        "status": status,
        "body": body,
        "elapsed_ms": meta["elapsed_ms"],
        "error": None if status == 200 else (body.get("detail") or body.get("error") or body),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--ids")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    data = json.loads(Path(args.corpus).read_text(encoding="utf-8"))
    prompt, terms, model = app_stt_config(data)
    scripts = data["scripts"]
    if args.ids:
        wanted = set(args.ids.split(","))
        scripts = [s for s in scripts if s["id"] in wanted]

    out_path = OUT / "stt" / f"{args.tag}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    results = json.loads(out_path.read_text(encoding="utf-8")) if out_path.exists() else {}
    total_seconds = 0.0
    for script in scripts:
        sid = script["id"]
        if not args.force and (results.get(sid) or {}).get("status") == 200:
            continue
        path = AUDIO / f"{sid}.wav"
        if not path.exists():
            print(f"missing audio for {sid}: {path}")
            continue
        duration = wav_duration(path)
        total_seconds += duration
        started = time.perf_counter()
        result = transcribe(path, prompt, terms, model)
        body = result["body"]
        record = {
            "id": sid,
            "category": script["category"],
            "status": result["status"],
            "audio_s": round(duration, 2),
            "wall_ms": round((time.perf_counter() - started) * 1000, 1),
            "request_time_ms": body.get("request_time_ms"),
            "text": body.get("text"),
            "confidence": body.get("confidence"),
            "error": result["error"],
        }
        results[sid] = record
        out_path.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"{sid:<28} {result['status']} {duration:5.1f}s {record['wall_ms']:6.0f}ms  {(record['text'] or '')[:90]!r}")

    print(f"\n{args.tag}: {len(results)} clips, {total_seconds / 60:.2f} min transcribed this run")


if __name__ == "__main__":
    main()
