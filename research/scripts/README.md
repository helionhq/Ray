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
python llm_eval.py --provider aai  --models gemma-4-31b --tag v4 --source sync_v3.json
python llm_eval.py --provider groq --models openai/gpt-oss-120b --tag v4 --source sync_v3.json --reasoning-effort low

# 4. Score / judge / inspect
python score.py --tags v4__gemma-4-31b --source sync_v3.json
python judge.py --tags v4__gemma-4-31b --judge openai/gpt-oss-120b --source sync_v3
python show.py  --tag v4__gemma-4-31b --ids long-rambling,names-tech
```

## Round 2: hard corpus, model sweep, hedged latency

The hard corpus (`research/corpus/hard_scripts.json`) writes the mess into the spoken text:
stutters, restarts, chained self-corrections, meaning-bearing "like"/"you know"/"kind of",
run-on lists, an email, spoken formatting commands, numbers/times and a 2-3 minute monologue.
`scripts.json` stays as the regression corpus.

```bash
cd research/scripts

# Hard-corpus TTS (~3.5 min audio, ~$0.11 Deepgram), then the real app path
python gen_hard_audio.py
cd ../review
python run_app_corpus.py --tag hard_v7 --corpus ../corpus/hard_scripts.json --warm

# Side-by-side model sweep on old + hard (non-streaming, paced for free tiers)
cd ../scripts
python sweep.py --provider aai  --tag v7 --models gemma-4-31b,qwen3.5-4b-32k-fast --sleep 2.2
python sweep.py --provider groq --tag v7 --models openai/gpt-oss-120b --split hard --sleep 20
python sweep.py --provider groq --tag v7 --models openai/gpt-oss-20b --split old \
  --ids long-rambling,long-technical,names-tech,heavy-disfluency,run-on,self-correction-date,self-correction-word,false-start,enum-tasks,numbers-dates,email-with-question,code-ish --sleep 20

# Score / judge / inspect (score.py understands require/forbid and email formatting)
python score.py --tags v7__gemma-4-31b --corpus ../corpus/hard_scripts.json --source hard_merged.json
python judge.py --tags v7__gemma-4-31b --corpus ../corpus/hard_scripts.json --source hard_merged --sleep 3
```

`run_app_corpus.py --warm` simulates the app pre-warming the gateway during recording;
`--cleanup-repeats N` repeats the warm cleanup on one transcript to measure p50/p95 of the
hedged path. `sweep.py` resumes a partially finished tag, so a 429 pause does not lose work.

Outputs land in `research/out/` (gitignored). `SPEND.md` is appended by `stt_test.py`.

Provider endpoints and auth headers are documented in `research/final/pipeline.json`.
