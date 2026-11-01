"""Generate the round-2 hard corpus with Deepgram Aura-2 TTS.

The disfluencies are written into `spoken`, so the audio really contains them.
Writes 16 kHz mono WAV into research/audio/ and repairs Deepgram's streaming
WAV header sizes.

Usage: python research/scripts/gen_hard_audio.py [--force]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from common import AUDIO, RESEARCH, ENV
from fix_wav import fix
from gen_audio import tts_long

CORPUS = RESEARCH / "corpus" / "hard_scripts.json"


def main() -> None:
    force = "--force" in sys.argv
    AUDIO.mkdir(parents=True, exist_ok=True)
    data = json.loads(CORPUS.read_text(encoding="utf-8"))
    total_chars = 0
    for script in data["scripts"]:
        path = AUDIO / f"{script['id']}.wav"
        total_chars += len(script["spoken"])
        if path.exists() and not force:
            print(f"skip {script['id']}")
            continue
        raw = tts_long(script["spoken"], script["voice"], script["speed"])
        path.write_bytes(raw)
        fix(path)
        print(
            f"wrote {path.name} ({len(raw) / 1024:.1f} KB, "
            f"voice={script['voice']}, speed={script['speed']})"
        )
    print(f"\nTTS chars: {total_chars} (~${total_chars / 1000 * 0.030:.3f} Deepgram)")


if __name__ == "__main__":
    main()
