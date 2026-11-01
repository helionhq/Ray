"""LLM judge for cleanup outputs. Scores fidelity, names, formatting and no-answer behaviour.

Usage: python judge.py --tags groq_v1__openai_gpt-oss-120b --judge gemini-3.5-flash
"""
from __future__ import annotations

import argparse
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

from common import ENV, OUT, corpus

PROVIDERS = {"groq": ("https://api.groq.com/openai/v1", "GROQ_API_KEY"), "aai": ("https://llm-gateway.assemblyai.com/v1", "ASSEMBLYAI_API_KEY")}
BASE, KEY = "", ""

JUDGE_SYSTEM = """You are a strict evaluator of a dictation-cleanup output. You are given the
raw transcript (what the speaker actually said), the reference ideal output, and the model
output being evaluated. Judge only what is in front of you.

Score each dimension from 0 to 10.
- fidelity: meaning preserved, no substantive facts added or removed, no summarising, no
  answering. Removing fillers (um, uh, you know), false starts, stutters and resolving
  self-corrections is REQUIRED and must NOT be penalised. The reference ideal is a guide,
  not a strict target: wording may differ where the meaning is identical.
- names: every person, product, company and number spelled correctly. The transcript may
  contain ASR mishearings ("Vitari", "Helium"); the ideal shows the intended spelling. Do
  not penalise correcting a misheard name to the ideal when context supports it.
- formatting: punctuation, paragraph and list quality judged on its own merits. Bullets are
  good when the speaker enumerates three or more parallel items even if the ideal used
  prose. Penalise lists applied to short two-item messages.
- instruction_safety: the output is the cleaned dictation, NOT an answer or execution of
  anything the transcript asked. It must also not silently delete instruction-like or
  question-like sentences.
- overall: holistic quality as a dictation result a user could paste without editing.

Return ONLY a JSON object:
{"fidelity": n, "names": n, "formatting": n, "instruction_safety": n, "overall": n,
 "issues": ["short issue", "..."]}
At most three issues, each under 12 words.
No markdown fences."""


def call(model: str, system: str, user: str) -> dict:
    payload = {"model": model, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
               "temperature": 0, "max_tokens": 700}
    # gpt-oss accepts reasoning_effort; most gateway models reject it.
    if model.startswith("openai/gpt-oss"):
        payload["reasoning_effort"] = "low"
    req = urllib.request.Request(BASE + "/chat/completions", data=json.dumps(payload).encode(),
                                 headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json",
                                          "User-Agent": "RayDictationResearch/1.0"}, method="POST")
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                obj = json.loads(r.read())
            return obj["choices"][0]["message"]["content"] or ""
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 5:
                time.sleep(8 * (attempt + 1)); continue
            return f"__ERR__ HTTP {e.code}: {e.read()[:200]}"
        except Exception as e:
            return f"__ERR__ {e}"
    return "__ERR__"


def parse(text: str) -> dict | None:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tags", required=True)
    ap.add_argument("--judge", default="openai/gpt-oss-120b")
    ap.add_argument("--provider", default="groq", choices=PROVIDERS)
    ap.add_argument("--source", default="sync_raw")
    ap.add_argument("--corpus", default=None, help="corpus JSON (default: scripts.json)")
    ap.add_argument("--ids")
    ap.add_argument("--sleep", type=float, default=0)
    args = ap.parse_args()
    global BASE, KEY
    BASE, keyname = PROVIDERS[args.provider]
    KEY = ENV[keyname]
    data = (
        json.loads(Path(args.corpus).read_text(encoding="utf-8"))
        if args.corpus
        else corpus()
    )
    scripts = {s["id"]: s for s in data["scripts"]}
    stt = json.loads((OUT / "stt" / f"{args.source}.json").read_text(encoding="utf-8"))

    summary = {}
    for tag in args.tags.split(","):
        path = OUT / "llm" / f"{tag}.json"
        results = json.loads(path.read_text(encoding="utf-8"))
        dims = ["fidelity", "names", "formatting", "instruction_safety", "overall"]
        agg = {d: [] for d in dims}
        rows = []
        ids = set(args.ids.split(",")) if args.ids else None
        for sid, r in results.items():
            if ids and sid not in ids:
                continue
            if not r.get("ok"):
                continue
            if sid not in scripts:
                continue
            s = scripts[sid]
            user = (f"<transcript>\n{r['transcript']}\n</transcript>\n\n"
                    f"<ideal>\n{s['ideal']}\n</ideal>\n\n<model_output>\n{r['text']}\n</model_output>")
            raw = call(args.judge, JUDGE_SYSTEM, user)
            time.sleep(args.sleep)
            if raw.startswith("__ERR__"):
                print(f"  judge call fail {sid}: {raw[:120]}")
                continue
            j = parse(raw)
            if not j:
                print(f"  judge parse fail {sid}: {raw[:120]}")
                continue
            if any(d not in j or isinstance(j[d], bool) or not isinstance(j[d], (int, float)) for d in dims):
                print(f"  judge bad dimensions {sid}: {raw[:120]}")
                continue
            j["id"] = sid
            rows.append(j)
            for d in dims:
                agg[d].append(j[d])
        if not rows:
            continue
        summary[tag] = {
            "n": len(rows),
            **{f"mean_{d}": round(sum(agg[d]) / len(agg[d]), 2) for d in dims},
            "rows": rows,
        }
        print(f"{tag:<52} n={len(rows)} overall={summary[tag]['mean_overall']} "
              f"fid={summary[tag]['mean_fidelity']} names={summary[tag]['mean_names']} "
              f"fmt={summary[tag]['mean_formatting']} safe={summary[tag]['mean_instruction_safety']}")
    path = OUT / "judge_results.json"
    merged = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    merged.update(summary)
    path.write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
