# AssemblyAI spend log

Budget: < $10. All figures are audio-minutes × list rate; AssemblyAI bills per second, so
these are close upper bounds. Rates: Dictation API $0.62/hr (rewrite included), Sync STT
$0.45/hr + $0.05/hr keyterms add-on.

| run | mode | audio min | est. cost $ | note |
|---|---|---:|---:|---|
| smoke | dictation-default | 0.07 | 0.0007 | request-shape check |
| dict_default | dictation-default | 8.36 | 0.0864 | full corpus, default cleanup |
| dict_v1 | dictation (smart) | 8.36 | 0.0864 | custom instruction v1 |
| dict_v2_smart | dictation (smart) | 8.36 | 0.0864 | custom instruction v2 |
| sync_raw | sync batch | 8.36 | 0.0697 | prompt + keyterms (0.45+0.05/hr) |
| sync_v3 | sync batch | 9.05 | 0.0754 | regenerated full corpus |
| sync_extra | sync batch | 0.47 | 0.0039 | 3 adversarial clips |
| sync_live_rt | sync live | 1.15 | 0.0096 | real-time paced long clip |
| pcm_live | sync live | 0.36 | 0.0030 | raw PCM protocol test |
| noisy | sync batch | 0.23 | 0.0019 | 28 dB SNR robustness clip |
| keyterm_ab | sync batch | 1.46 | 0.0122 | 9 A/B variants (keyterms on/off) |

**Total STT spend: ~$0.44** (46.2 audio-minutes). Well under the $10 budget.

Not counted above: AssemblyAI LLM Gateway tokens (a separate token bill). ~190 test
requests at ~1.4k input / 250 output tokens on Gemma 4 31B ($0.14/$0.40 per M) ≈ **$0.06**.
Production cost is ~$0.0003 per dictation.
Deepgram TTS: ~12.7k characters generated (two full corpus passes) ≈ **$0.38** (not AssemblyAI).
