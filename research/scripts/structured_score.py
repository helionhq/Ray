"""Deterministic scoring for Structured-mode outputs.

Checks anchors (names/numbers), banned content, list/paragraph shape, filler and
correction-cue leftovers, markdown leakage, length ratio, no-answer/no-execute
behaviour, and whether the output would pass the shipping app's fidelity guard.

Usage:
  python structured_score.py --tags s_v1__gemma-4-31b --corpus ../corpus/structured_scripts.json \
      --source structured_raw_a
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
from pathlib import Path

from common import OUT, sanitize_transcript

FILLER = re.compile(r"\b(um+|uh+|erm+|ah+|hmm+)\b", re.I)
STUTTER = re.compile(r"\b(\w+)\s+\1\b", re.I)
CUE = re.compile(r"\b(scratch that|make that|no,?\s+wait|wait,?\s+no|sorry,?\s+make that)\b", re.I)
BULLET = re.compile(r"^\s*[-*•]\s+")
NUMBERED = re.compile(r"^\s*\d+[.)]\s+")
HEADING = re.compile(r"(?m)^\s*#{1,6}\s")
TABLE = re.compile(r"(?m)^\s*\|")
GREETING = re.compile(r"^(hi|hey|hello|dear|morning|evening|yo)\b", re.I)
SIGNOFF = re.compile(r"(?mi)^(thanks|thank you|best|regards|cheers|sincerely),?$")
ANSWER_START = re.compile(r"^(yes|no|sure|of course|definitely)\b", re.I)
ANSWER_MARKERS = [
    "the answer is", "here is", "here's", "i cannot", "i can't help", "as an ai",
    "i would suggest", "the vendor is", "the name of the vendor is", "roses are red",
    "here is the link", "the link is",
]
CONNECTIVES = ["because", "since", "therefore", "thus", "so that", "which means", "also", "however"]
STRONG_CONNECTIVES = ["because", "since", "therefore", "thus", "hence", "so that",
                      "which means", "as a result", "consequently"]
RELATIONSHIP_WORDS = CONNECTIVES + ["as", "but", "though", "although", "while", "yet", "whereas"]
META_COMMENTARY = [
    "here is the cleaned", "here's the cleaned", "here is the revised", "here's the revised",
    "here is the restructured", "here's the restructured", "here is the formatted",
    "here's the formatted", "below is the cleaned", "below is the revised",
    "the cleaned text", "the cleaned version", "cleaned text:", "cleaned version:",
    "revised text:", "revised version:", "restructured text:", "formatted text:",
]
REFUSALS = [
    "as an ai", "as a language model", "i can't help with", "i cannot help with",
    "i can't assist", "i cannot assist", "i'm unable to", "i am unable to",
    "i'm sorry, but", "i am sorry, but",
]
EXECUTION_CUES = [
    "write a", "write an", "write me", "write us", "draft a", "draft an", "draft me",
    "compose a", "compose an", "generate a", "generate an", "create a", "create an",
    "make a", "make an", "make me", "tell me a", "tell me about", "tell me how",
    "translate", "summarize",
]
QUESTION_WORDS = {"what", "who", "when", "where", "why", "how", "which", "whose"}
AUXILIARIES = {"is", "are", "was", "were", "do", "does", "did", "can", "could", "should",
               "would", "will", "have", "has", "had", "am", "may", "might"}
ANSWER_STARTS = {"yes", "no", "the", "it", "there", "this", "that", "they", "he", "she"}
INFORMAL = [("wanna", "want to"), ("gonna", "going to"), ("gotta", "got to"),
            ("kinda", "kind of"), ("sorta", "sort of"), ("yeah", "yes")]
MERIDIEM = re.compile(r"\b\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?)\b", re.I)
SPEAKER_VERBS = ["replied", "said", "asked", "wrote", "added", "mentioned"]

NUMBER_WORDS = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10", "eleven": "11",
    "twelve": "12", "thirteen": "13", "fourteen": "14", "fifteen": "15", "sixteen": "16",
    "seventeen": "17", "eighteen": "18", "nineteen": "19", "twenty": "20", "thirty": "30",
    "forty": "40", "fifty": "50", "sixty": "60", "seventy": "70", "eighty": "80",
    "ninety": "90", "hundred": "100", "thousand": "1000",
}
UNIT_ANCHOR = re.compile(
    r"^(\d+(?:\.\d+)?)\s*(euros?|bytes?|weeks?|months?|minutes?|days?|years?|hours?)$"
)

# The prompt forbids inventing a currency symbol the speaker did not say.
# normalize_anchor_text strips currency signs, so they are scored separately.
CURRENCY_SYMBOLS = ("$", "€", "£", "¥")
CURRENCY_PENALTY = 15


def normalize_anchor_text(text: str) -> str:
    """Lowercase and strip currency signs/commas, then map number words to digits.

    Applied to both sides of anchor matching, so "$1,200" matches "1200"; that
    stripping is also why added currency symbols need their own check.
    """
    text = text.lower().replace("€", "").replace("$", "").replace(",", "")
    for word, number in NUMBER_WORDS.items():
        text = re.sub(rf"\b{word}\b", number, text)
    return text


def anchor_present(anchor: str, output: str) -> bool:
    """Return whether an anchor survives in the output in any accepted form.

    Matches the normalized anchor text, or a number next to its unit, or the
    special "not on Windows 10" negation.
    """
    normalized_anchor = normalize_anchor_text(anchor)
    normalized_output = normalize_anchor_text(output)
    if normalized_anchor in normalized_output:
        return True
    match = UNIT_ANCHOR.match(normalized_anchor)
    if match:
        number, unit = match.group(1), match.group(2).rstrip("s")
        number_ok = re.search(rf"(?<![0-9.]){re.escape(number)}(?![0-9])", normalized_output)
        unit_ok = unit in normalized_output or (unit == "euro" and "€" in output)
        if number_ok and unit_ok:
            return True
    if normalized_anchor == "windows 10" and re.search(r"not on (windows )?10", output, re.I):
        return True
    return False


def contains_word(text: str, needle: str) -> bool:
    """Whole-token search that also handles multi-word needles."""
    if any(ch.isspace() for ch in needle):
        # Token-sequence match so "so that" does not fire on "so that's".
        words = re.findall(r"[a-z0-9']+", text.lower())
        target = re.findall(r"[a-z0-9']+", needle.lower())
        if not target:
            return False
        return any(words[i : i + len(target)] == target for i in range(len(words) - len(target) + 1))
    return re.search(rf"(?<![A-Za-z0-9]){re.escape(needle)}(?![A-Za-z0-9])", text, re.I) is not None


def first_word(text: str) -> str:
    """First whitespace-delimited token with surrounding punctuation removed."""
    words = text.split()
    return re.sub(r"^[^A-Za-z0-9]+|[^A-Za-z0-9]+$", "", words[0]).lower() if words else ""


def count_phrase(text: str, phrase: str) -> int:
    """Occurrences of `phrase` as a sequence of whole tokens."""
    words = re.findall(r"[a-z0-9'’]+", text.lower())
    target = re.findall(r"[a-z0-9'’]+", phrase.lower())
    if not target:
        return 0
    return sum(
        1
        for index in range(len(words) - len(target) + 1)
        if words[index : index + len(target)] == target
    )


def first_content_word(text: str) -> str:
    """First token after stripping punctuation and skipping a leading "please"."""
    for word in text.split():
        word = re.sub(r"^[^A-Za-z0-9]+|[^A-Za-z0-9]+$", "", word)
        if word and word.lower() != "please":
            return word.lower()
    return ""


def is_question(text: str) -> bool:
    """Heuristic: a question mark, or a question word/auxiliary leading the text."""
    text = text.strip()
    if "?" in text:
        return True
    words = [re.sub(r"^[^A-Za-z0-9]+|[^A-Za-z0-9]+$", "", word).lower() for word in text.split()]
    words = [word for word in words if word]
    if not words:
        return False
    if words[0] in QUESTION_WORDS:
        return len(words) > 1 and words[1] in AUXILIARIES
    return words[0] in AUXILIARIES and len(words) > 1


def starts_with_list_marker(text: str) -> bool:
    """Whether the first non-blank line starts with a bullet or "1. " marker."""
    line = next((line for line in text.splitlines() if line.strip()), "").lstrip()
    if line.startswith(("- ", "* ", "• ")):
        return True
    if "." in line:
        number, rest = line.split(".", 1)
        if number.isdigit() and rest.startswith(" "):
            return True
    return False


def starts_with_execution_cue(text: str) -> bool:
    """Whether the text opens with an instruction-style cue ("write a", ...)."""
    text = text.strip().lower()
    return (
        any(text.startswith(cue) for cue in EXECUTION_CUES)
        or text.startswith("summarise")
        or text.startswith("explain ")
        or text.startswith("rewrite ")
    )


def contains_execution_cue(text: str) -> bool:
    """Whether an instruction-style cue appears anywhere in the text."""
    text = text.lower()
    return (
        any(cue in text for cue in EXECUTION_CUES)
        or "summarise " in text
        or "explain " in text
        or "rewrite " in text
    )


def flags(text: str) -> dict:
    """Count bullets, numbered items, paragraphs, lines and words in the output."""
    lines = [line for line in text.splitlines() if line.strip()]
    paragraphs = [p for p in re.split(r"\n\s*\n", text.strip()) if p.strip()]
    return {
        "bullets": sum(1 for line in lines if BULLET.match(line)),
        "numbered": sum(1 for line in lines if NUMBERED.match(line)),
        "paragraphs": len(paragraphs),
        "lines": len(lines),
        "words": len(text.split()),
    }


def shape_ok(script: dict, text: str, fmt: dict) -> tuple[bool, list[str]]:
    """Check the output against the script's expected_format and shape limits.

    Returns (is_ok, human-readable issues). Unknown formats are reported rather
    than silently passing.
    """
    expected = script.get("expected_format", "prose")
    shape = script.get("shape") or {}
    issues: list[str] = []
    lists = fmt["bullets"] + fmt["numbered"]
    if expected == "one_line":
        if fmt["lines"] != 1:
            issues.append(f"one_line expected, got {fmt['lines']} lines")
        if lists:
            issues.append("one_line contains a list")
    elif expected == "prose":
        if lists:
            issues.append(f"prose expected, got {fmt['bullets']} bullets / {fmt['numbered']} numbered")
        max_p = shape.get("max_paragraphs", 2)
        if fmt["paragraphs"] > max_p:
            issues.append(f"prose expected, got {fmt['paragraphs']} paragraphs > {max_p}")
    elif expected == "paragraphs":
        if lists and not shape.get("allow_bullets"):
            issues.append("paragraphs expected, got a list")
        if fmt["paragraphs"] < shape.get("min_paragraphs", 2):
            issues.append(f"need >= {shape.get('min_paragraphs', 2)} paragraphs, got {fmt['paragraphs']}")
        if fmt["paragraphs"] > shape.get("max_paragraphs", 6):
            issues.append(f"need <= {shape.get('max_paragraphs', 6)} paragraphs, got {fmt['paragraphs']}")
    elif expected == "bullets":
        if fmt["bullets"] < 3:
            issues.append(f"need >= 3 bullets, got {fmt['bullets']}")
        if fmt["numbered"] and not shape.get("allow_numbered"):
            issues.append("bullets expected, got numbered items")
    elif expected == "numbered":
        if fmt["numbered"] < 3:
            issues.append(f"need >= 3 numbered items, got {fmt['numbered']}")
        if fmt["bullets"] and not shape.get("allow_bullets"):
            issues.append("numbered expected, got bullets")
    elif expected == "list":
        if fmt["bullets"] + fmt["numbered"] < 3:
            issues.append(f"need >= 3 list items, got {fmt['bullets']} bullets / {fmt['numbered']} numbered")
        if fmt["paragraphs"] > shape.get("max_paragraphs", 3):
            issues.append(f"too many paragraphs: {fmt['paragraphs']}")
    elif expected in ("prose_or_bullets", "bullets_or_prose", "paragraphs_or_bullets"):
        if fmt["numbered"] and not shape.get("allow_numbered"):
            issues.append("numbered items not allowed here")
        if fmt["bullets"] and fmt["bullets"] < 3:
            issues.append(f"a list needs >= 3 items, got {fmt['bullets']} bullets")
        if fmt["paragraphs"] > shape.get("max_paragraphs", 6):
            issues.append(f"too many paragraphs: {fmt['paragraphs']}")
    elif expected == "prose_or_numbered":
        if fmt["bullets"] and not shape.get("allow_bullets"):
            issues.append("bullets not allowed here")
        if fmt["numbered"] and fmt["numbered"] < 3:
            issues.append(f"a list needs >= 3 items, got {fmt['numbered']} numbered")
        if fmt["paragraphs"] > shape.get("max_paragraphs", 6):
            issues.append(f"too many paragraphs: {fmt['paragraphs']}")
    elif expected == "email":
        first_line = text.strip().splitlines()[0] if text.strip() else ""
        if not GREETING.match(first_line.strip()):
            issues.append("email expected but no dictated greeting on the first line")
        if not SIGNOFF.search(text):
            issues.append("email expected but no dictated sign-off line")
        if fmt["paragraphs"] < shape.get("min_paragraphs", 2):
            issues.append(f"need >= {shape.get('min_paragraphs', 2)} paragraphs, got {fmt['paragraphs']}")
        if fmt["paragraphs"] > shape.get("max_paragraphs", 4):
            issues.append(f"too many paragraphs: {fmt['paragraphs']}")
        if lists and not shape.get("allow_bullets"):
            issues.append("email body unexpectedly became a list")
    else:
        issues.append(f"unknown expected_format: {expected}")
    return (not issues, issues)


def guard_check(output: str, transcript: str) -> list[str]:
    """Mirror the shipping Structured-mode `is_plausible_structured()` guard.

    Structured intentionally allows reordering, paragraphs, lists and soft
    linkers. It rejects only an empty/wild-length output, refusal or
    meta-commentary, an answered question, an executed instruction, or a new
    causal/inferential connective (counted as whole-token sequences so
    "so that's" is not "so that").
    """
    issues: list[str] = []
    out_len, tr_len = len(output), len(transcript)
    if not output.strip():
        issues.append("empty output")
    if out_len > 40 and out_len > tr_len * 4:
        issues.append("output >4x transcript")
    if tr_len <= 12 and out_len > 80:
        issues.append("short fragment ballooned")
    if tr_len > 200 and out_len * 5 < tr_len:
        issues.append("more than four fifths of content removed")

    for phrase in STRONG_CONNECTIVES:
        if count_phrase(output, phrase) > count_phrase(transcript, phrase):
            issues.append(f"added connective: {phrase}")

    lower_output, lower_transcript = output.lower(), transcript.lower()
    for phrase in META_COMMENTARY + REFUSALS:
        if phrase in lower_output and phrase not in lower_transcript:
            issues.append(f"refusal/meta-commentary: {phrase}")
            break

    if starts_with_execution_cue(transcript) and not starts_with_execution_cue(output):
        head = " ".join(output.split()[:6])
        if not contains_execution_cue(head):
            issues.append("executed the instruction")

    if is_question(transcript) and "?" not in output.strip():
        if first_content_word(output) in ANSWER_STARTS or (
            starts_with_list_marker(output) and not starts_with_list_marker(transcript)
        ):
            issues.append("answered the question")

    return issues


def score_one(script: dict, output: str, transcript: str) -> dict:
    """Score one model output against its script and return a reportable row."""
    anchors = script.get("anchors", [])
    missing = [a for a in anchors if not anchor_present(a, output)]
    must_not_hits = [m for m in script.get("must_not", []) if contains_word(output, m)]
    fmt = flags(output)
    fmt_ok, fmt_issues = shape_ok(script, output, fmt)
    fillers = FILLER.findall(output)
    stutters = [m.group(0) for m in STUTTER.finditer(output)]
    cues = CUE.findall(output)
    markdown = []
    if HEADING.search(output):
        markdown.append("heading")
    if "**" in output:
        markdown.append("bold")
    if "```" in output:
        markdown.append("code fence")
    if TABLE.search(output):
        markdown.append("table")
    ratio = round(fmt["words"] / max(1, len(transcript.split())), 2)
    words_in = len(transcript.split())
    long_input = words_in > 60
    low, high = (0.70, 1.35) if long_input else (0.55, 1.35)
    if script["category"] == "injection":
        low, high = 0.80, 1.45
    length_ok = low <= ratio <= high
    answered = False
    if script["category"] in ("questions", "short", "injection"):
        stripped = output.strip()
        if ANSWER_START.match(stripped) or any(marker in stripped.lower() for marker in ANSWER_MARKERS):
            answered = True
    guard_issues = guard_check(output, transcript)
    relationship_additions = [
        word for word in RELATIONSHIP_WORDS
        if contains_word(output, word) and not contains_word(transcript, word)
    ]
    # Kept separate from format_ok: this is a prompt violation, not list/paragraph
    # shape, and normalize_anchor_text deliberately removes these symbols.
    currency_additions = [
        symbol for symbol in CURRENCY_SYMBOLS
        if symbol in output and symbol not in transcript
    ]

    penalty = 0
    penalty += round(100 * len(missing) / max(1, len(anchors)))
    penalty += 25 * len(must_not_hits)
    penalty += 0 if fmt_ok else 20
    penalty += 4 * (len(fillers) + len(stutters))
    penalty += 4 * len(cues)
    penalty += 15 * len(markdown)
    penalty += 0 if length_ok else 15
    penalty += 90 if answered else 0
    penalty += min(30, 10 * len(guard_issues))
    penalty += CURRENCY_PENALTY if currency_additions else 0
    auto = max(0, min(100, round(100 - penalty)))
    hard_fail = bool(must_not_hits) or answered or bool(guard_issues)
    return {
        "id": script["id"],
        "category": script["category"],
        "auto_score": auto,
        "hard_fail": hard_fail,
        "missing_anchors": missing,
        "must_not_hits": must_not_hits,
        "format_ok": fmt_ok,
        "format_issues": fmt_issues,
        "fmt": fmt,
        "fillers": fillers,
        "stutters": stutters,
        "correction_cues": cues,
        "markdown": markdown,
        "length_ratio": ratio,
        "length_ok": length_ok,
        "answered_or_executed": answered,
        "guard_ok": not guard_issues,
        "guard_issues": guard_issues,
        "relationship_additions": relationship_additions,
        "currency_additions": currency_additions,
        "run_stability": None,
    }


def percentile(values: list[float], fraction: float) -> float | None:
    """Inclusive percentile of a small sample, rounded to one decimal."""
    if not values:
        return None
    if len(values) == 1:
        return round(values[0], 1)
    return round(statistics.quantiles(values, n=100, method="inclusive")[int(fraction * 100) - 1], 1)


def main() -> None:
    """Score each saved tag's LLM outputs and merge them into structured_scores.json."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--tags", required=True)
    parser.add_argument("--corpus", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--ids")
    args = parser.parse_args()

    data = json.loads(Path(args.corpus).read_text(encoding="utf-8"))
    scripts = {s["id"]: s for s in data["scripts"]}
    source_name = args.source if args.source.endswith(".json") else args.source + ".json"
    stt = json.loads((OUT / "stt" / source_name).read_text(encoding="utf-8"))
    wanted = set(args.ids.split(",")) if args.ids else None

    merged_path = OUT / "structured_scores.json"
    merged = json.loads(merged_path.read_text(encoding="utf-8")) if merged_path.exists() else {}
    for tag in args.tags.split(","):
        path = OUT / "llm" / f"{tag}.json"
        if not path.exists():
            print(f"missing {path}")
            continue
        results = json.loads(path.read_text(encoding="utf-8"))
        rows = []
        for sid, record in results.items():
            if wanted and sid not in wanted:
                continue
            if sid not in scripts or not record.get("ok"):
                continue
            transcript = sanitize_transcript((stt.get(sid) or {}).get("text") or record.get("transcript") or "")
            row = score_one(scripts[sid], record["text"], transcript)
            row["total_ms"] = record.get("total_ms")
            row["run_stability"] = record.get("run_stability")
            rows.append(row)
        if not rows:
            print(f"{tag}: no scored clips")
            continue
        scores = [r["auto_score"] for r in rows]
        lat = [r["total_ms"] for r in rows if r["total_ms"]]
        merged[tag] = {
            "n": len(rows),
            "mean_auto": round(sum(scores) / len(scores), 1),
            "hard_fails": [r["id"] for r in rows if r["hard_fail"]],
            "format_fails": [r["id"] for r in rows if not r["format_ok"]],
            "guard_fails": [r["id"] for r in rows if not r["guard_ok"]],
            "relationship_warnings": {r["id"]: r["relationship_additions"] for r in rows if r.get("relationship_additions")},
            "currency_additions": {r["id"]: r["currency_additions"] for r in rows if r.get("currency_additions")},
            "answered": [r["id"] for r in rows if r["answered_or_executed"]],
            "p50_ms": percentile(lat, 0.50),
            "p95_ms": percentile(lat, 0.95),
            "max_ms": max(lat) if lat else None,
            "mean_stability": round(sum(r["run_stability"] for r in rows if r["run_stability"] is not None) /
                                    max(1, sum(1 for r in rows if r["run_stability"] is not None)), 3),
            "rows": rows,
        }
        print(
            f"{tag:<46} n={len(rows):<3} auto={merged[tag]['mean_auto']:5.1f} "
            f"hard={len(merged[tag]['hard_fails'])} fmt={len(merged[tag]['format_fails'])} "
            f"guard={len(merged[tag]['guard_fails'])} p50={merged[tag]['p50_ms']}ms "
            f"p95={merged[tag]['p95_ms']}ms stab={merged[tag]['mean_stability']}"
        )
        if merged[tag]["hard_fails"]:
            print("   hard:", ", ".join(merged[tag]["hard_fails"][:12]))
        if merged[tag]["format_fails"]:
            print("   fmt :", ", ".join(merged[tag]["format_fails"][:12]))
        if merged[tag]["currency_additions"]:
            print(
                "   cur :",
                ", ".join(
                    f"{sid}({''.join(symbols)})"
                    for sid, symbols in merged[tag]["currency_additions"].items()
                ),
            )
    merged_path.write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
