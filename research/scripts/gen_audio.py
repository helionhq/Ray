"""Generate dictation audio for the corpus via Deepgram Aura-2 TTS.

Writes 16 kHz mono WAV (laptop-mic-like) into research/audio/, plus a
lightly-noised variant of one script to sanity-check robustness.

Usage: python research/scripts/gen_audio.py [--force]
"""
from __future__ import annotations

import io
import json
import random
import struct
import sys
import wave
from pathlib import Path

from common import AUDIO, ENV, corpus, http_multipart

DEEPGRAM = "https://api.deepgram.com/v1/speak"
HEADERS = {"Authorization": f"Token {ENV['DEEPGRAM_API_KEY']}"}


def tts_raw(text: str, voice: str, speed: float, sample_rate: int = 16000) -> bytes:
    import urllib.request

    url = f"{DEEPGRAM}?model={voice}&encoding=linear16&sample_rate={sample_rate}&container=wav&speed={speed}"
    req = urllib.request.Request(
        url,
        data=json.dumps({"text": text}).encode(),
        headers={**HEADERS, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def tts_long(text: str, voice: str, speed: float) -> bytes:
    """Aura truncates around 1000 characters, so split long scripts and stitch PCM."""
    import re

    if len(text) <= 900:
        return tts_raw(text, voice, speed)
    parts, buf = [], ""
    for sent in re.split(r"(?<=[.!?])\s+", text):
        if len(buf) + len(sent) + 1 > 800 and buf:
            parts.append(buf)
            buf = sent
        else:
            buf = (buf + " " + sent).strip()
    if buf:
        parts.append(buf)
    frames, params = [], None
    for part in parts:
        with wave.open(io.BytesIO(tts_raw(part, voice, speed)), "rb") as w:
            params = w.getparams()
            frames.append(w.readframes(w.getnframes()))
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setparams(params)
        w.writeframes(b"".join(frames))
    return out.getvalue()


def add_noise(wav_bytes: bytes, snr_db: float = 28.0) -> bytes:
    """Add gentle white noise at ~28 dB SNR to mimic a laptop mic."""
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        params = w.getparams()
        frames = w.readframes(w.getnframes())
    samples = list(struct.unpack(f"<{len(frames) // 2}h", frames))
    rms = (sum(s * s for s in samples) / max(1, len(samples))) ** 0.5
    noise_rms = rms / (10 ** (snr_db / 20))
    rnd = random.Random(7)
    noisy = [max(-32768, min(32767, int(s + rnd.gauss(0, noise_rms)))) for s in samples]
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setparams(params)
        w.writeframes(struct.pack(f"<{len(noisy)}h", *noisy))
    return out.getvalue()


def main() -> None:
    force = "--force" in sys.argv
    AUDIO.mkdir(parents=True, exist_ok=True)
    data = corpus()
    total_chars = 0
    for s in data["scripts"]:
        path = AUDIO / f"{s['id']}.wav"
        total_chars += len(s["spoken"])
        if path.exists() and not force:
            print(f"skip {s['id']}")
            continue
        raw = tts_long(s["spoken"], s["voice"], s["speed"])
        path.write_bytes(raw)
        print(f"wrote {path.name} ({len(raw) / 1024:.1f} KB, voice={s['voice']}, speed={s['speed']})")
        if s["id"] == "heavy-disfluency":
            (AUDIO / "heavy-disfluency-noisy.wav").write_bytes(add_noise(raw))
            print("wrote heavy-disfluency-noisy.wav")
    print(f"\nTTS chars: {total_chars} (~${total_chars / 1000 * 0.030:.3f} Deepgram)")


if __name__ == "__main__":
    main()
