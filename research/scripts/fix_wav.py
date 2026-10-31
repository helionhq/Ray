"""Repair Deepgram streaming WAV headers (0x7FFF0000 placeholder sizes) so standard
parsers and STT APIs see the correct duration."""
from __future__ import annotations

import struct
import sys
from pathlib import Path

from common import AUDIO


def fix(path: Path) -> bool:
    raw = bytearray(path.read_bytes())
    if raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        return False
    pos = 12
    data_size = None
    while pos + 8 <= len(raw):
        cid = bytes(raw[pos : pos + 4])
        size = struct.unpack("<I", raw[pos + 4 : pos + 8])[0]
        if cid == b"data":
            data_size = len(raw) - (pos + 8)
            struct.pack_into("<I", raw, pos + 4, data_size)
            break
        pos += 8 + size + (size % 2)
    if data_size is None:
        return False
    struct.pack_into("<I", raw, 4, len(raw) - 8)
    path.write_bytes(bytes(raw))
    return True


if __name__ == "__main__":
    paths = [Path(p) for p in sys.argv[1:]] or sorted(AUDIO.glob("*.wav"))
    for p in paths:
        print(("fixed " if fix(p) else "skip  ") + p.name)
