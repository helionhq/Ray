"""Automatic scoring of cleanup outputs against reference ideals.

Usage: python score.py --tags groq_v1,g120
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
from pathlib import Path

from common import FINAL, OUT, corpus

FILLERS = re.compile(r"\b(um+|uh+|erm+|ah+|you know|i mean|sort of|kind of|like,)(?!\w)", re.I)
CORRECTION_CUES = re.compile(r"\b(no,? actually|sorry,|wait,? no|i mean,)(?!\w)", re.I)


def norm_words(s: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", s.lower())


def sim(a: str, b: str) -> float:
    return round(difflib.SequenceMatcher(None, norm_words(a), norm_words(b)).ratio(), 3)


def fmt_flags(text: str) -> dict:
    lines = [l for l in text.splitlines() if l.strip()]
    bullets = sum(1 for l in lines if re.match(r"^\s*[-*•]\s+", l))
    numbered = sum(1 for l in lines if re.match(r"^\s*\d+[.)]\s+", l))
    paras = len([p for p in re.split(r"\n\s*\n", text.strip()) if p.strip()])
    return {"bullets": bullets, "numbered": numbered, "paragraphs": paras, "lines": len(lines)}


def score_one(script: dict, out: str, transcript: str, names: list[str]) -> dict:
    ideal = script["ideal"]
    flags = fmt_flags(out)
    required = [n for n in names if n in ideal]
    missing = [n for n in required if n not in out]
    wrong_case = [n for n in required if n.lower() in out.lower() and n not in out]
    fmt = script["expected_format"]
    fmt_ok = True
    if fmt == "prose":
        fmt_ok = flags["bullets"] == 0 and flags["numbered"] == 0
    elif fmt == "bullets":
        fmt_ok = flags["bullets"] >= 2
    elif fmt == "numbered":
        fmt_ok = flags["numbered"] >= 2
    elif fmt == "paragraphs":
        fmt_ok = flags["paragraphs"] >= 2
    filler_hits = len(FILLERS.findall(out))
    cue_hits = len(CORRECTION_CUES.findall(out))
    ratio_vs_transcript = round(len(out.split()) / max(1, len(transcript.split())), 2)
    checks = {
        "missing_names": missing,
        "wrong_case_names": wrong_case,
        "filler_hits": filler_hits,
        "correction_cues": cue_hits,
        "format_ok": fmt_ok,
        "format": fmt,
        "fmt_flags": flags,
        "sim_ideal": sim(out, ideal),
        "sim_transcript": sim(out, transcript),
        "len_ratio_vs_transcript": ratio_vs_transcript,
    }
    penalties = 0
    penalties += 12 * len(missing) + 4 * len(wrong_case)
    penalties += 6 * filler_hits + 5 * cue_hits
    penalties += 0 if fmt_ok else 18
    if script["category"] in ("no-answer", "no-execute"):
        penalties += 0 if 0.65 <= ratio_vs_transcript <= 1.25 else 30
    score = max(0, min(100, round(100 * checks["sim_ideal"] - penalties)))
    checks["auto_score"] = score
    return checks


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tags", required=True)
    ap.add_argument("--source", default="../out/stt/sync_raw.json")
    args = ap.parse_args()
    data = corpus()
    scripts = {s["id"]: s for s in data["scripts"]}
    names = data["dictionary"] + data["builtin_names"]
    stt = json.loads((OUT / "stt" / Path(args.source).name).read_text(encoding="utf-8"))

    report = {}
    for tag in args.tags.split(","):
        path = OUT / "llm" / f"{tag}.json"
        if not path.exists():
            print(f"missing {path}")
            continue
        results = json.loads(path.read_text(encoding="utf-8"))
        scores, lat = [], []
        rows = []
        for sid, r in results.items():
            if not r.get("ok"):
                continue
            s = score_one(scripts[sid], r["text"], (stt.get(sid) or {}).get("text") or "", names)
            s["id"] = sid
            s["ttft_ms"] = r.get("ttft_ms")
            s["total_ms"] = r.get("total_ms")
            scores.append(s["auto_score"])
            lat.append(r.get("total_ms") or 0)
            rows.append(s)
        report[tag] = {
            "n": len(scores),
            "mean_auto_score": round(sum(scores) / max(1, len(scores)), 1),
            "mean_total_ms": round(sum(lat) / max(1, len(lat))),
            "p95_total_ms": sorted(lat)[int(len(lat) * 0.95) - 1] if lat else None,
            "rows": rows,
        }
        bad = [r["id"] for r in rows if r["auto_score"] < 80]
        print(f"{tag:<28} n={len(scores)} mean={report[tag]['mean_auto_score']} avg_ms={report[tag]['mean_total_ms']} p95_ms={report[tag]['p95_total_ms']} low={bad}")

    (OUT / "scores.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
