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

Outputs land in `research/out/` (gitignored). `SPEND.md` is appended by `stt_test.py`.

Provider endpoints and auth headers are documented in `research/final/pipeline.json`.
