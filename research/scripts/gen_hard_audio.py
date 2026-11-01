"""Generate a corpus with Deepgram Aura-2 TTS.

The disfluencies are written into `spoken`, so the audio really contains them.
Writes 16 kHz mono WAV into research/audio/ and repairs Deepgram's streaming
WAV header sizes.

Usage: python research/scripts/gen_hard_audio.py [--force]
       python research/scripts/gen_hard_audio.py --corpus ../corpus/heldout_scripts.json
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from common import AUDIO, RESEARCH
from fix_wav import fix
from gen_audio import tts_long

DEFAULT_CORPUS = RESEARCH / "corpus" / "hard_scripts.json"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default=str(DEFAULT_CORPUS))
    ap.add_argument("--ids", help="comma-separated script ids")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    AUDIO.mkdir(parents=True, exist_ok=True)
    data = json.loads(Path(args.corpus).read_text(encoding="utf-8"))
    scripts = data["scripts"]
    if args.ids:
        wanted = set(args.ids.split(","))
        scripts = [s for s in scripts if s["id"] in wanted]
    total_chars = 0
    for script in scripts:
        path = AUDIO / f"{script['id']}.wav"
        total_chars += len(script["spoken"])
        if path.exists() and not args.force:
            print(f"skip {script['id']}")
            continue
        raw = tts_long(script["spoken"], script["voice"], script["speed"])
        path.write_bytes(raw)
        fix(path)
        print(
            f"wrote {path.name} ({len(raw) / 1024:.1f} KB, "
            f"voice={script['voice']}, speed={script['speed']})"
        )
    print(
        f"\nTTS chars: {total_chars} "
        f"(~${total_chars / 1000 * 0.030:.3f} Deepgram)"
    )


if __name__ == "__main__":
    main()
