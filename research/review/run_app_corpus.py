"""Run the research corpus through Ray's shipping Rust pipeline (selftest binary).

Unlike research/scripts/stt_test.py, this does not reimplement anything: each
clip is fed to `ray --selftest-stream` (or `--selftest`), which uses the real
config, STT client, prompt substitution, cleanup chain and sanitisation.

Outputs are written in the shapes the existing score.py / judge.py read:

  research/out/stt/<tag>.json   {id: {text, audio_s, wall_ms, status}}
  research/out/llm/<tag>.json   {id: {ok, text, transcript, provider, total_ms}}

Usage:
  python research/review/run_app_corpus.py --tag app_sync_live
  python research/review/run_app_corpus.py --tag app_sync_live --ids long-rambling,names-tech
  python research/review/run_app_corpus.py --tag app_structured --mode structured \
      --corpus research/corpus/structured_scripts.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RESEARCH = ROOT / "research"
CORPUS = RESEARCH / "corpus" / "scripts.json"
AUDIO = RESEARCH / "audio"
OUT = RESEARCH / "out"
EXE = Path(
    os.environ.get(
        "RAY_REVIEW_EXE",
        ROOT / "src-tauri" / "target" / "review" / "debug" / "ray.exe",
    )
)
if not EXE.exists():
    EXE = ROOT / "src-tauri" / "target" / "debug" / "ray.exe"


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    path = ROOT / ".env"
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def duration(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / w.getframerate()


RAW_RE = re.compile(
    r"--- RAW ---\n(.*?)\n\n--- CLEAN \(([^)]*)\) ---\n(.*?)(?:\n\[selftest\]|\Z)", re.S
)
STT_MS_RE = re.compile(r"\[selftest\] timing stop_to_transcript_ms=(\d+)")
CLEAN_MS_RE = re.compile(r"\[selftest\] timing cleanup_ms=(\d+)")
NOTE_RE = re.compile(r"\[selftest\] note: (.*)")
REPEAT_RE = re.compile(r"\[selftest\] timing cleanup_repeat_(\d+)_ms=(\d+) provider=(\S+)")


def parse(stdout: str) -> tuple[str, str, str, int | None, int | None, str | None]:
    match = RAW_RE.search(stdout)
    if not match:
        return "", "", "", None, None, None
    raw = match.group(1).strip()
    provider = match.group(2).strip()
    clean = match.group(3).strip()
    stt_ms = STT_MS_RE.search(stdout)
    clean_ms = CLEAN_MS_RE.search(stdout)
    note = NOTE_RE.search(stdout)
    return (
        raw,
        provider,
        clean,
        int(stt_ms.group(1)) if stt_ms else None,
        int(clean_ms.group(1)) if clean_ms else None,
        note.group(1).strip() if note else None,
    )


def main() -> None:
    """Run each corpus clip through the Ray selftest binary and merge the outputs.

    Writes STT and cleanup results in the shapes score.py / judge.py consume.
    """
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", required=True)
    ap.add_argument(
        "--corpus",
        default=str(CORPUS),
        help="corpus JSON (default: the regression corpus; pass hard_scripts.json for round 2)",
    )
    ap.add_argument("--ids", help="comma-separated script ids")
    ap.add_argument("--batch", action="store_true", help="use --selftest (batch) instead of live")
    ap.add_argument(
        "--mode",
        choices=("clean", "structured"),
        help="cleanup mode (default: the app's/default clean mode)",
    )
    ap.add_argument("--dictionary", default="Arham,Helion,Ray")
    ap.add_argument("--app", default="Notepad")
    ap.add_argument("--force-fallback", action="store_true")
    ap.add_argument("--warm", action="store_true", help="pre-warm the cleanup connection")
    ap.add_argument("--repeat-cleanup", action="store_true")
    ap.add_argument("--cleanup-repeats", type=int, help="run N extra warm cleanups on each clip")
    args = ap.parse_args()

    data = json.loads(Path(args.corpus).read_text(encoding="utf-8"))
    scripts = data["scripts"]
    if args.ids:
        wanted = set(args.ids.split(","))
        scripts = [s for s in scripts if s["id"] in wanted]

    env = os.environ.copy()
    env.update({k: v for k, v in load_env().items() if k not in env})
    env["RAY_TEST_DICTIONARY"] = args.dictionary
    env["RAY_TEST_APP_NAME"] = args.app
    if args.mode:
        env["RAY_CLEANUP_MODE"] = args.mode
    if args.force_fallback:
        env["RAY_TEST_FORCE_FALLBACK"] = "1"
    if args.warm:
        env["RAY_TEST_WARM"] = "1"
    if args.repeat_cleanup:
        env["RAY_TEST_REPEAT_CLEANUP"] = "1"
    if args.cleanup_repeats:
        env["RAY_TEST_CLEANUP_REPEATS"] = str(args.cleanup_repeats)

    (OUT / "stt").mkdir(parents=True, exist_ok=True)
    (OUT / "llm").mkdir(parents=True, exist_ok=True)

    # Merge with an existing run so resuming a subset keeps prior clips.
    stt_path = OUT / "stt" / f"{args.tag}.json"
    llm_path = OUT / "llm" / f"{args.tag}.json"
    stt_results = json.loads(stt_path.read_text(encoding="utf-8")) if stt_path.exists() else {}
    llm_results = json.loads(llm_path.read_text(encoding="utf-8")) if llm_path.exists() else {}

    for script in scripts:
        sid = script["id"]
        wav = AUDIO / f"{sid}.wav"
        if not wav.exists():
            print(f"missing {wav}", file=sys.stderr)
            continue
        flag = "--selftest" if args.batch else "--selftest-stream"
        started = time.perf_counter()
        proc = subprocess.run(
            [str(EXE), flag, str(wav)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=600,
        )
        wall_ms = round((time.perf_counter() - started) * 1000)
        raw, provider, clean, stt_ms, cleanup_ms, note = parse(proc.stdout)
        ok = proc.returncode == 0 and bool(clean)
        stt_results[sid] = {
            "id": sid,
            "text": raw,
            "audio_s": round(duration(wav), 2),
            "wall_ms": wall_ms,
            "stop_to_transcript_ms": stt_ms,
            "status": 200 if raw else 0,
            "error": None if raw else (proc.stderr.strip().splitlines() or ["no transcript"])[-1],
            "stderr": None if raw else proc.stderr.strip()[-2000:],
        }
        llm_results[sid] = {
            "ok": ok,
            "text": clean,
            "transcript": raw,
            "provider": provider,
            "total_ms": cleanup_ms if cleanup_ms is not None else wall_ms,
            "wall_ms": wall_ms,
            "ttft_ms": None,
            "note": note,
            "cleanup_repeats": [
                {"ms": int(match.group(2)), "provider": match.group(3)}
                for match in REPEAT_RE.finditer(proc.stdout)
            ],
            "error": None if ok else (proc.stderr.strip().splitlines() or ["cleanup failed"])[-1],
        }
        print(
            f"{sid:<26} {'ok ' if ok else 'ERR'} {stt_results[sid]['audio_s']:6.1f}s "
            f"wall={wall_ms:6d}ms provider={provider or '-':<10} {clean[:70]!r}"
        )
        if not ok:
            print(f"   stderr: {proc.stderr.strip()[-800:]}")
        stt_path.write_text(json.dumps(stt_results, indent=2, ensure_ascii=False), encoding="utf-8")
        llm_path.write_text(json.dumps(llm_results, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"\n{args.tag}: {len(scripts)} clips -> {stt_path} / {llm_path}")


if __name__ == "__main__":
    main()
