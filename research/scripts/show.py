"""Print transcript / ideal / model output side by side for chosen scripts.

Usage: python show.py --tag v3__gemma-4-31b --ids long-rambling,names-tech
"""
import argparse
import json

from common import OUT, corpus


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", required=True)
    ap.add_argument("--ids", required=True)
    ap.add_argument("--source", default="sync_v3")
    args = ap.parse_args()
    data = {s["id"]: s for s in corpus()["scripts"]}
    res = json.loads((OUT / "llm" / f"{args.tag}.json").read_text(encoding="utf-8"))
    src = args.source if args.source.endswith(".json") else args.source + ".json"
    stt = json.loads((OUT / "stt" / src).read_text(encoding="utf-8"))
    for sid in args.ids.split(","):
        r = res.get(sid, {})
        print("=" * 78)
        print("ID:", sid, "| latency:", r.get("total_ms"), "ms | ok:", r.get("ok"))
        print("-- RAW --")
        print(stt.get(sid, {}).get("text", ""))
        print("-- IDEAL --")
        print(data[sid]["ideal"])
        print("-- OUTPUT --")
        print(r.get("text") if r.get("ok") else r.get("error"))


if __name__ == "__main__":
    main()
