"""Shared helpers for the Ray dictation-quality research scripts.

Reads API keys from D:\\dev\\ray\\.env (never logs them).
Stdlib only, so it runs on the stock Python install.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]          # D:\dev\ray
RESEARCH = ROOT / "research"
CORPUS = RESEARCH / "corpus" / "scripts.json"
AUDIO = RESEARCH / "audio"
OUT = RESEARCH / "out"
FINAL = RESEARCH / "final"


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


ENV = load_env()


def corpus() -> dict:
    return json.loads(CORPUS.read_text(encoding="utf-8"))


def http_json(
    url: str,
    payload: dict | None = None,
    headers: dict | None = None,
    method: str | None = None,
    timeout: float = 120,
) -> tuple[int, dict, dict]:
    data = json.dumps(payload).encode() if payload is not None else None
    hdrs = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method or ("POST" if data else "GET"))
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
            return r.status, json.loads(body or b"{}"), {"elapsed_ms": (time.perf_counter() - t0) * 1000, "headers": dict(r.headers)}
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = {"raw": body.decode("utf-8", "replace")}
        return e.code, parsed, {"elapsed_ms": (time.perf_counter() - t0) * 1000, "headers": dict(e.headers)}


def multipart(fields: dict[str, tuple[str, bytes, str]]) -> tuple[bytes, str]:
    """fields: name -> (filename, bytes, content_type). filename '' => regular field."""
    boundary = "----rayresearch" + os.urandom(8).hex()
    out = bytearray()
    for name, (filename, content, ctype) in fields.items():
        out += f"--{boundary}\r\n".encode()
        if filename:
            out += f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'.encode()
        else:
            out += f'Content-Disposition: form-data; name="{name}"\r\n'.encode()
        out += f"Content-Type: {ctype}\r\n\r\n".encode()
        out += content + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


def http_multipart(url: str, fields: dict, headers: dict | None = None, timeout: float = 120) -> tuple[int, dict, dict]:
    body, ctype = multipart(fields)
    req = urllib.request.Request(url, data=body, headers={"Content-Type": ctype, **(headers or {})}, method="POST")
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, json.loads(raw or b"{}"), {"elapsed_ms": (time.perf_counter() - t0) * 1000, "headers": dict(r.headers)}
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = {"raw": raw.decode("utf-8", "replace")}
        return e.code, parsed, {"elapsed_ms": (time.perf_counter() - t0) * 1000, "headers": dict(e.headers)}


def wav_duration(path: Path) -> float:
    import wave

    with wave.open(str(path), "rb") as w:
        return w.getnframes() / w.getframerate()


def sanitize_transcript(text: str) -> str:
    """Mirror the app's sanitize_transcript before the prompt is built."""
    out: list[str] = []
    chars = list(text)
    for index, char in enumerate(chars):
        if char != "�":
            out.append(char)
            continue
        previous_is_word = bool(out) and out[-1].isalnum()
        following = next((c for c in chars[index + 1 :] if not c.isspace()), "")
        next_is_word = bool(following) and following.isalnum()
        if previous_is_word and next_is_word:
            out.append(",")
            if index + 1 < len(chars) and not chars[index + 1].isspace():
                out.append(" ")
    cleaned = "".join(
        char for char in out
        if not ("\x00" <= char <= "\x08" or char in "\x0b\x0c" or "\x0e" <= char <= "\x1f")
    )
    return " ".join(cleaned.split())
