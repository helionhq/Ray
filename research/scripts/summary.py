"""Summarise auto score and latency for one or more cleanup tags and corpora.

Usage:
  python summary.py --tags app_v7_final --source app_v7_final.json
  python summary.py --tags hard_v7_final --corpus ../corpus/hard_scripts.json --source hard_v7_final.json
  python summary.py --tags sweep_v7__openai_gpt-oss-20b --corpus ../corpus/hard_scripts.json --source hard_merged.json
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from common import OUT, corpus
from score import score_one


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round(fraction * len(ordered))) - 1))
    return ordered[index]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tags", required=True)
    parser.add_argument("--corpus", default=None)
    parser.add_argument("--source", required=True)
    parser.add_argument("--ids", default=None)
    args = parser.parse_args()

    data = (
        json.loads(Path(args.corpus).read_text(encoding="utf-8"))
        if args.corpus
        else corpus()
    )
    scripts = {script["id"]: script for script in data["scripts"]}
    names = data["dictionary"] + data["builtin_names"]
    source = json.loads((OUT / "stt" / Path(args.source).name).read_text(encoding="utf-8"))
    wanted = set(args.ids.split(",")) if args.ids else None

    for tag in args.tags.split(","):
        results = json.loads((OUT / "llm" / f"{tag}.json").read_text(encoding="utf-8"))
        scores: list[int] = []
        latencies: list[float] = []
        rows = []
        for sid, script in scripts.items():
            if wanted and sid not in wanted:
                continue
            record = results.get(sid)
            if not record or not record.get("ok"):
                continue
            checks = score_one(
                script,
                record["text"],
                (source.get(sid) or {}).get("text") or record.get("transcript") or "",
                names,
            )
            scores.append(checks["auto_score"])
            latencies.append(record.get("total_ms") or 0)
            rows.append((sid, checks["auto_score"], record.get("total_ms") or 0, record.get("provider")))
        if not scores:
            print(f"{tag}: no scored clips")
            continue
        rows.sort(key=lambda row: row[1])
        print(
            f"{tag:<44} n={len(scores):<3} auto={sum(scores) / len(scores):5.1f} "
            f"p50={percentile(latencies, 0.50):7.0f}ms p95={percentile(latencies, 0.95):7.0f}ms "
            f"max={max(latencies):7.0f}ms"
        )
        print("   lowest:", ", ".join(f"{sid}={score}" for sid, score, _, _ in rows[:5]))


if __name__ == "__main__":
    main()
