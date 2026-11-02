"""Print transcript, meaning units and Structured output side by side.

Usage:
  python structured_show.py --tag s_v1__gemma-4-31b --source structured_raw_a --ids st-mono-launch
  python structured_show.py --tag s_v1__gemma-4-31b --source structured_raw_a --all --low
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from common import OUT, sanitize_transcript


def main() -> None:
    """Print transcript, meaning units, scored issues and output for selected clips."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--ids", default="")
    parser.add_argument("--corpus", default="../corpus/structured_scripts.json")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--low", action="store_true", help="only rows with an auto score below 90")
    args = parser.parse_args()

    data = json.loads((OUT.parent / "corpus" / Path(args.corpus).name).read_text(encoding="utf-8"))
    scripts = {s["id"]: s for s in data["scripts"]}
    source_name = args.source if args.source.endswith(".json") else args.source + ".json"
    stt = json.loads((OUT / "stt" / source_name).read_text(encoding="utf-8"))
    llm = json.loads((OUT / "llm" / f"{args.tag}.json").read_text(encoding="utf-8"))
    scores_path = OUT / "structured_scores.json"
    scores = json.loads(scores_path.read_text(encoding="utf-8")) if scores_path.exists() else {}
    rows = {row["id"]: row for row in (scores.get(args.tag) or {}).get("rows", [])}

    ids = list(scripts) if args.all else args.ids.split(",")
    for sid in ids:
        if sid not in scripts or sid not in llm:
            continue
        row = rows.get(sid) or {}
        if args.low and row.get("auto_score", 0) >= 90:
            continue
        print("=" * 100)
        print(f"ID: {sid} | category: {scripts[sid]['category']} | auto: {row.get('auto_score')} | "
              f"hard: {row.get('hard_fail')} | fmt: {row.get('format_ok')} | guard: {row.get('guard_ok')}")
        if row.get("missing_anchors"):
            print("missing anchors:", row["missing_anchors"])
        if row.get("must_not_hits"):
            print("must-not hits:", row["must_not_hits"])
        if row.get("format_issues"):
            print("format issues:", row["format_issues"])
        if row.get("currency_additions"):
            print("currency additions:", row["currency_additions"])
        if row.get("guard_issues"):
            print("guard issues:", row["guard_issues"])
        print("-- RAW --")
        print(sanitize_transcript(stt.get(sid, {}).get("text", "")))
        print("-- MEANING UNITS --")
        for unit in scripts[sid].get("meaning_units", []):
            print("-", unit)
        print("-- OUTPUT --")
        print(llm[sid].get("text") if llm[sid].get("ok") else llm[sid].get("error"))


if __name__ == "__main__":
    main()
