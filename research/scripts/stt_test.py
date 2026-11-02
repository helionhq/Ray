"""Run the corpus through AssemblyAI STT variants and record outputs + latency + spend.

Modes:
  dictation          Dictation API (batch /v1/transcribe) with custom llm_instruction
  dictation-default  Dictation API with default cleanup only
  dictation-live     Dictation API live endpoint, streamed in chunks
  sync               Sync STT batch (/v1/transcribe) with prompt + keyterms
  sync-live          Sync STT live endpoint, streamed in chunks

Usage:
  python stt_test.py --mode dictation --tag dict_v1 --instruction-file ../out/instruction_v1.txt
"""
from __future__ import annotations

import argparse
import http.client
import json
import ssl
import time
from pathlib import Path

from common import AUDIO, ENV, OUT, corpus, http_json, http_multipart, wav_duration

AAI_KEY = ENV["ASSEMBLYAI_API_KEY"]
DICTATION_BASE = "https://dictation.assemblyai.com"
SYNC_BASE = "https://sync.assemblyai.com"
STT_PROMPT = (
    "A software founder dictating short messages, emails, meeting notes and technical "
    "instructions about their desktop dictation app and AI tooling. Mostly English, with "
    "product and company names. Speech may contain filler words and self-corrections."
)


def cfg_base(names: dict) -> dict:
    return {
        "stt_prompt": STT_PROMPT,
        "keyterms_prompt": names["dictionary"] + names["builtin_names"],
    }


def wav_bytes(path: Path) -> bytes:
    return path.read_bytes()


def run_dictation(path: Path, names: dict, instruction: str | None, live: bool, rewrite_mode: str = "smart") -> dict:
    cfg = cfg_base(names)
    if instruction:
        cfg["llm_instruction"] = instruction
        cfg["rewrite_mode"] = rewrite_mode
    endpoint = f"{DICTATION_BASE}/v1/transcribe" + ("/live" if live else "")
    fields = {
        "config": ("", json.dumps(cfg).encode(), "application/json"),
        "audio": (path.name, wav_bytes(path), "audio/wav"),
    }
    status, body, meta = http_multipart(endpoint, fields, headers={"Authorization": AAI_KEY}, timeout=180)
    return {"status": status, "body": body, "elapsed_ms": meta["elapsed_ms"]}


def run_sync(path: Path, names: dict, live: bool) -> dict:
    cfg = {k: v for k, v in cfg_base(names).items() if k != "stt_prompt"}
    cfg["prompt"] = STT_PROMPT
    endpoint = f"{SYNC_BASE}/v1/transcribe" + ("/live" if live else "")
    fields = {
        "config": ("", json.dumps(cfg).encode(), "application/json"),
        "audio": (path.name, wav_bytes(path), "audio/wav"),
    }
    status, body, meta = http_multipart(
        endpoint,
        fields,
        headers={"Authorization": AAI_KEY, "X-AAI-Model": "universal-3-5-pro"},
        timeout=180,
    )
    return {"status": status, "body": body, "elapsed_ms": meta["elapsed_ms"]}


def stream_live(host: str, path: str, cfg: dict, audio: bytes, chunk_ms: int = 500, realtime: bool = False) -> dict:
    """Chunked multipart upload: config part first, then audio written as it arrives."""
    boundary = "----raystream7f3a"
    ctx = ssl.create_default_context()
    conn = http.client.HTTPSConnection(host, timeout=180, context=ctx)
    conn.putrequest("POST", path, skip_host=False)
    conn.putheader("Authorization", AAI_KEY)
    conn.putheader("X-AAI-Model", "universal-3-5-pro")
    conn.putheader("Content-Type", f"multipart/form-data; boundary={boundary}")
    conn.putheader("Transfer-Encoding", "chunked")
    conn.endheaders()

    def send_chunk(data: bytes) -> None:
        conn.send(f"{len(data):X}\r\n".encode() + data + b"\r\n")

    cfg_json = json.dumps(cfg).encode()
    send_chunk(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"config\"\r\n"
        f"Content-Type: application/json\r\n\r\n".encode() + cfg_json + b"\r\n"
    )
    send_chunk(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"chunk.wav\"\r\n"
        f"Content-Type: audio/wav\r\n\r\n".encode()
    )

    # Send the 44-byte WAV header first, then payload in ~chunk_ms slices.
    header, payload = audio[:44], audio[44:]
    send_chunk(header)
    bytes_per_chunk = int(16000 * 2 * chunk_ms / 1000)
    t0 = time.perf_counter()
    for i in range(0, len(payload), bytes_per_chunk):
        send_chunk(payload[i : i + bytes_per_chunk])
        if realtime:
            target = t0 + (i + bytes_per_chunk) / (16000 * 2)
            delay = target - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
    send_chunk(f"\r\n--{boundary}--\r\n".encode())
    conn.send(b"0\r\n\r\n")
    resp = conn.getresponse()
    raw = resp.read()
    elapsed = (time.perf_counter() - t0) * 1000
    conn.close()
    try:
        body = json.loads(raw)
    except Exception:
        body = {"raw": raw.decode("utf-8", "replace")}
    return {"status": resp.status, "body": body, "elapsed_ms": elapsed}


def log_spend(mode: str, seconds: float, note: str = "") -> None:
    rate = 0.62 if mode.startswith("dictation") else 0.50
    cost = seconds / 3600 * rate
    path = OUT.parent / "SPEND.md"
    if not path.exists():
        path.write_text(
            "# AssemblyAI spend log\n\n| run | mode | audio min | est. cost $ | note |\n"
            "|---|---|---:|---:|---|\n",
            encoding="utf-8",
        )
    with path.open("a", encoding="utf-8") as f:
        f.write(f"| {time.strftime('%Y-%m-%d %H:%M')} | {mode} | {seconds / 60:.2f} | {cost:.4f} | {note} |\n")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", required=True, choices=["dictation", "dictation-default", "dictation-live", "sync", "sync-live"])
    ap.add_argument("--tag", required=True)
    ap.add_argument("--instruction-file")
    ap.add_argument("--ids", help="comma-separated script ids")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--realtime", action="store_true", help="pace live upload at wall-clock speed")
    ap.add_argument("--rewrite-mode", default="smart", choices=["fast", "smart"])
    args = ap.parse_args()

    data = corpus()
    names = {"dictionary": data["dictionary"], "builtin_names": data["builtin_names"]}
    scripts = data["scripts"]
    if args.ids:
        wanted = set(args.ids.split(","))
        scripts = [s for s in scripts if s["id"] in wanted]
    if args.limit:
        scripts = scripts[: args.limit]

    instruction = None
    if args.instruction_file:
        instruction = Path(args.instruction_file).read_text(encoding="utf-8")

    (OUT / "stt").mkdir(parents=True, exist_ok=True)
    results = {}
    total_seconds = 0.0
    for s in scripts:
        path = AUDIO / f"{s['id']}.wav"
        if not path.exists():
            print(f"missing audio {path}")
            continue
        dur = wav_duration(path)
        total_seconds += dur
        t0 = time.perf_counter()
        if args.mode in ("dictation", "dictation-default"):
            r = run_dictation(path, names, instruction if args.mode == "dictation" else None, live=False, rewrite_mode=args.rewrite_mode)
        elif args.mode == "sync":
            r = run_sync(path, names, live=False)
        elif args.mode == "dictation-live":
            cfg = cfg_base(names)
            if instruction:
                cfg["llm_instruction"] = instruction
                cfg["rewrite_mode"] = args.rewrite_mode
            r = stream_live("dictation.assemblyai.com", "/v1/transcribe/live", cfg, wav_bytes(path), realtime=args.realtime)
        else:
            cfg = {k: v for k, v in cfg_base(names).items() if k != "stt_prompt"}
            cfg["prompt"] = STT_PROMPT
            r = stream_live("sync.assemblyai.com", "/v1/transcribe/live", cfg, wav_bytes(path), realtime=args.realtime)
        wall = (time.perf_counter() - t0) * 1000
        body = r["body"]
        rec = {
            "id": s["id"],
            "category": s["category"],
            "status": r["status"],
            "audio_s": round(dur, 2),
            "wall_ms": round(wall, 1),
            "request_time_ms": body.get("request_time_ms"),
            "text": body.get("text"),
            "llm_response": body.get("llm_response"),
            "llm_error": body.get("llm_error"),
            "confidence": body.get("confidence"),
            "error": body.get("detail") or body.get("error") if r["status"] != 200 else None,
        }
        results[s["id"]] = rec
        out_text = rec["llm_response"] or rec["text"] or ""
        print(f"{s['id']:<24} {r['status']} {dur:5.1f}s wall={wall:6.0f}ms  {out_text[:80]!r}")
        (OUT / "stt" / f"{args.tag}.json").write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")

    log_spend(args.mode, total_seconds, args.tag)
    print(f"\n{args.tag}: {len(results)} clips, {total_seconds / 60:.2f} min audio")


if __name__ == "__main__":
    main()
