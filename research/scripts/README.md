# Reproduce the dictation-quality tests

Python 3.14 (stdlib only), Node not needed. API keys come from `D:\dev\ray\.env`.

```bash
cd research/scripts

# 1. TTS corpus (Deepgram Aura-2, 16 kHz mono WAV) — ~9 min of audio, ~$0.20
python gen_audio.py --force
python fix_wav.py                 # repair Deepgram streaming WAV header sizes

# 2. STT variants
python stt_test.py --mode sync --tag sync_v3                       # chosen: Sync batch
python stt_test.py --mode dictation --tag dict --instruction-file ../out/instruction_v2.txt
python stt_test.py --mode dictation-default --tag dict_default

# 3. LLM cleanup (prompt is read from research/final/cleanup_system_prompt.md)
python llm_eval.py --provider aai --models gemma-4-31b --tag v4 --source sync_v3.json

# 4. Score / judge / inspect
python score.py --tags v4__gemma-4-31b --source sync_v3.json
python judge.py --tags v4__gemma-4-31b --judge qwen3.5-4b-32k-fast --source sync_v3
python show.py  --tag v4__gemma-4-31b --ids long-rambling,names-tech
```

## Round 2: hard corpus, model sweep, hedged latency

The hard corpus (`research/corpus/hard_scripts.json`) writes the mess into the spoken text:
stutters, restarts, chained self-corrections, meaning-bearing "like"/"you know"/"kind of",
run-on lists, an email, spoken formatting commands, numbers/times and a 2-3 minute monologue.
`scripts.json` stays as the regression corpus.

```bash
cd research/scripts

# Hard-corpus TTS (~3.5 min audio, ~$0.11 Deepgram), then the real app path.
# run_app_corpus.py defaults to corpus/scripts.json and writes out/stt/<tag>.json +
# out/llm/<tag>.json, so the regression corpus needs no --corpus flag.
python gen_hard_audio.py
cd ../review
python run_app_corpus.py --tag app_v7 --warm
python run_app_corpus.py --tag hard_v7 --corpus ../corpus/hard_scripts.json --warm

# Side-by-side model sweep on old + hard (non-streaming, paced for the gateway).
# Both transcript sources are explicit: app_v7.json (old) and hard_v7.json (hard).
cd ../scripts
python sweep.py --provider aai --tag v7 --models gemma-4-31b,qwen3.5-4b-32k-fast \
  --old-source app_v7.json --hard-source hard_v7.json --sleep 2.2
# Score / judge / inspect (score.py understands require/forbid, email and format checks).
# score.py resolves --source by filename under out/stt/; judge.py takes the tag without .json.
python score.py --tags v7__gemma-4-31b --corpus ../corpus/hard_scripts.json --source ../out/stt/hard_v7.json
python judge.py --tags v7__gemma-4-31b --corpus ../corpus/hard_scripts.json --source hard_v7 --sleep 3
```

`run_app_corpus.py --warm` simulates the app pre-warming the gateway during recording;
`--cleanup-repeats N` repeats the warm cleanup on one transcript to measure p50/p95 of the
hedged path. `sweep.py` resumes a partially finished tag, so a 429 pause does not lose work.

Outputs land in `research/out/` (gitignored). `SPEND.md` is appended by `stt_test.py`.

Provider endpoints and auth headers are documented in `research/final/pipeline.json`.

## Round 3: current-prompt re-run and held-out corpus

`research/corpus/heldout_scripts.json` is a 20-clip out-of-sample corpus: new people,
places, products, numbers and scenarios, ids prefixed `ho-`. It was checked for shared
4/5-grams and content numbers against the prompt examples and both existing corpora, so it
does not reuse a sentence, name pairing, number or scenario. The run-on-list rule was
narrowed after the first two post-fix attempts; `app_v11` / `hard_v11` / `heldout_v11` are
the final runs on the frozen eval binary, and `app_v9` / `hard_v9` / `heldout_v9` are the
pre-fix baseline.

```bash
cd research/scripts

# Held-out TTS (~4.6 min audio, ~$0.11 Deepgram). --corpus defaults to hard_scripts.json;
# --force regenerates existing WAVs instead of reusing possibly outdated audio.
python gen_hard_audio.py --corpus ../corpus/heldout_scripts.json --force

# Build into a separate target dir and copy the binary to a private path. Running
# target/debug/ray.exe directly locks it, which breaks `pnpm tauri dev`; the copy is also
# the frozen binary behind the numbers. Paths derive from the checkout, so they work on
# any machine.
REPO="$(git rev-parse --show-toplevel)"
cd ../../src-tauri
CARGO_TARGET_DIR="$REPO/src-tauri/target/eval-build" cargo build
mkdir -p target/eval
cp target/eval-build/debug/ray.exe target/eval/ray.exe
cd ../research/scripts
cd ../review
export RAY_REVIEW_EXE="$REPO/src-tauri/target/eval/ray.exe"
python run_app_corpus.py --tag app_v11 --warm
python run_app_corpus.py --tag hard_v11 --corpus ../corpus/hard_scripts.json --warm
python run_app_corpus.py --tag heldout_v11 --corpus ../corpus/heldout_scripts.json --warm

# Score / judge. App-path runs write out/stt/<tag>.json and out/llm/<tag>.json, so the
# score tag and the --source stub are both <tag>.
cd ../scripts
python score.py --tags app_v11 --corpus ../corpus/scripts.json --source ../out/stt/app_v11.json
python score.py --tags hard_v11 --corpus ../corpus/hard_scripts.json --source ../out/stt/hard_v11.json
python score.py --tags heldout_v11 --corpus ../corpus/heldout_scripts.json --source ../out/stt/heldout_v11.json
python judge.py --tags app_v11 --corpus ../corpus/scripts.json --source app_v11 --provider aai --judge qwen3.5-4b-32k-fast --sleep 2
python judge.py --tags hard_v11 --corpus ../corpus/hard_scripts.json --source hard_v11 --provider aai --judge qwen3.5-4b-32k-fast --sleep 2
python judge.py --tags heldout_v11 --corpus ../corpus/heldout_scripts.json --source heldout_v11 --provider aai --judge qwen3.5-4b-32k-fast --sleep 2
```

`run_app_corpus.py` merges into an existing tag, so `--ids <id>` can repair one clip without
re-running the corpus. `judge.py` exits non-zero and reports a corpus mismatch when none of
a tag's transcript ids are in the selected corpus; a mixed tag judges the matching ids and
warns. The `ho-bullets` audio was regenerated once with a different Aura-2 voice after the
first voice produced a deterministic ASR failure; the script above rebuilds all held-out
audio from the corpus voices.

## Structured mode

`src-tauri/prompts/structured.md` (mirror: `research/final/structured_system_prompt.md`) is the
restructuring prompt. The corpora are `research/corpus/structured_scripts.json` (42 tuning
clips) and `research/corpus/structured_heldout_scripts.json` (14 held-out clips). Each item
carries `meaning_units` (atomic facts the judge checks), `anchors` (names/numbers), `must_not`
(banned content) and a `shape` (paragraph/list restraint) for deterministic scoring.

```bash
cd research/scripts

# Audio (Deepgram Aura-2) and STT (AssemblyAI Sync batch, with the app's prompt + keyterms)
python gen_hard_audio.py --corpus ../corpus/structured_scripts.json
python gen_hard_audio.py --corpus ../corpus/structured_heldout_scripts.json
python structured_stt.py --corpus ../corpus/structured_scripts.json --tag structured_raw_a
python structured_stt.py --corpus ../corpus/structured_heldout_scripts.json --tag structured_heldout_a

# Eval (gemma-4-31b, two runs so stability is measured)
python structured_eval.py --corpus ../corpus/structured_scripts.json --source structured_raw_a \
  --models gemma-4-31b --tag s_v6 --runs 2

# Deterministic score, then two LLM judges (only gemma/qwen are accessible on this account)
python structured_score.py --tags s_v6__gemma-4-31b --corpus ../corpus/structured_scripts.json --source structured_raw_a
python structured_judge.py --tags s_v6__gemma-4-31b --corpus ../corpus/structured_scripts.json --source structured_raw_a \
  --judge qwen3.5-4b-32k-fast --second-judge gemma-4-31b --sleep 4

# Side-by-side transcript / meaning units / output
python structured_show.py --tag s_v6__gemma-4-31b --source structured_raw_a --all
```

Held-out uses the same commands with `structured_heldout_scripts.json`,
`structured_heldout_a` and the `s_v6_heldout` tag. `structured_eval.py` retries 429s, but the
gateway's per-account TPM limit means qwen needs a slower `--sleep` and a lower `--max-tokens`
than gemma. `structured_score.py` simulates the shipping Structured-mode guard
(`is_plausible_structured`: added causal/inferential connectives are matched as token sequences;
soft linkers such as "also" are allowed); `structured_judge.py` records token usage for spend
accounting. `run_app_corpus.py --mode structured` runs the same corpus through the real app
binary with the Structured prompt and guard.

The older Clean-mode scripts no longer contain a second-provider code path: `llm_eval.py`,
`judge.py` and `sweep.py` use the AssemblyAI LLM Gateway only. "Groq" remains only as dictation
vocabulary in corpora, the STT keyterm list, and the Clean prompt's Grok/Groq disambiguation
rule.
