"""Run generated edge cases through the shipping Rust pipeline.

  python research/review/run_extra.py --only inj,dictated,slack,mixed,numbers,casual,very,names-gpt
  python research/review/run_extra.py --only rs- --mode resample
  python research/review/run_extra.py --only rollover --batch
  python research/review/run_extra.py --only silence,noise

16 kHz files use --selftest-stream (live). Any other rate uses
--selftest-resample, which runs the audio through audio.rs first.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
import wave
from pathlib import Path

from run_app_corpus import EXE, ROOT, load_env, parse

AUDIO = ROOT / "research" / "out" / "review" / "audio"
RESULTS = ROOT / "research" / "out" / "review" / "results.json"


def rate_of(path: Path) -> int:
    with wave.open(str(path), "rb") as w:
        return w.getframerate()


def duration(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / w.getframerate()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="comma-separated filename substrings")
    ap.add_argument("--tag", default="extra")
    ap.add_argument("--batch", action="store_true")
    ap.add_argument("--resample", action="store_true", help="always use --selftest-resample")
    ap.add_argument("--warm", action="store_true", help="pre-warm the cleanup connection")
    ap.add_argument("--repeat-cleanup", action="store_true")
    ap.add_argument("--app-name", default="Notepad")
    ap.add_argument("--dictionary", default="Arham,Helion,Ray")
    args = ap.parse_args()

    wanted = [part for part in args.only.split(",") if part]
    files = sorted(AUDIO.glob("*.wav"))
    if wanted:
        files = [path for path in files if any(part in path.stem for part in wanted)]
    if not files:
        raise SystemExit(f"no audio matched {args.only!r} in {AUDIO}")

    env = os.environ.copy()
    env.update({key: value for key, value in load_env().items() if key not in env})
    env["RAY_TEST_DICTIONARY"] = args.dictionary
    env["RAY_TEST_APP_NAME"] = args.app_name
    if args.warm:
        env["RAY_TEST_WARM"] = "1"
    if args.repeat_cleanup:
        env["RAY_TEST_REPEAT_CLEANUP"] = "1"

    prior = json.loads(RESULTS.read_text(encoding="utf-8")) if RESULTS.exists() else {}
    results = prior.get(args.tag, {})

    for path in files:
        rate = rate_of(path)
        if args.batch:
            flag = "--selftest"
        elif args.resample or rate != 16_000:
            flag = "--selftest-resample"
        else:
            flag = "--selftest-stream"
        started = time.perf_counter()
        proc = subprocess.run(
            [str(EXE), flag, str(path)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=720,
        )
        wall_ms = round((time.perf_counter() - started) * 1000)
        raw, provider, clean, stt_ms, cleanup_ms, note = parse(proc.stdout)
        record = {
            "file": path.name,
            "rate": rate,
            "audio_s": round(duration(path), 2),
            "flag": flag,
            "returncode": proc.returncode,
            "raw": raw,
            "clean": clean,
            "provider": provider,
            "stt_ms": stt_ms,
            "cleanup_ms": cleanup_ms,
            "wall_ms": wall_ms,
            "note": note,
            "stderr_tail": proc.stderr.strip().splitlines()[-1:] if proc.stderr.strip() else [],
        }
        results[path.name] = record
        RESULTS.parent.mkdir(parents=True, exist_ok=True)
        RESULTS.write_text(json.dumps(prior | {args.tag: results}, indent=2, ensure_ascii=False), encoding="utf-8")
        print(
            f"{path.name:<28} {flag:<20} rc={proc.returncode} "
            f"stt={stt_ms}ms llm={cleanup_ms}ms wall={wall_ms}ms"
        )
        print(f"   RAW  : {raw!r}")
        print(f"   CLEAN: {clean!r}")
        if record["stderr_tail"]:
            print(f"   ERR  : {record['stderr_tail'][0]}")


if __name__ == "__main__":
    main()
