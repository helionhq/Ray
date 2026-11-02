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

## Round 2 (hard corpus + guards + hedging)

| run | mode | audio min | est. cost $ | note |
|---|---|---:|---:|---|
| hard_baseline | sync live | 4.46 | 0.0372 | first pass, 18 hard clips |
| hard_probe | sync live | 0.73 | 0.0061 | revised restart/run-on/email/product clips |
| hard_v5 | sync live | 4.50 | 0.0375 | prompt v5 + max_tokens 3000 |
| hard_v6 | sync live | 4.50 | 0.0375 | fidelity guards |
| hard_v7 | sync live | 0.43 | 0.0036 | chained-correction probe |
| old_probe | sync live | 1.22 | 0.0102 | Grok/Groq + draft-reply probes |
| **round-2 development subtotal** | | **15.84** | **0.1321** | |
| round-2 final suite | sync live + sync batch | 32.71 | 0.2726 | old + hard final, warm repeats, fallback probe, adversarial extras, rollover |

**Round 2 STT subtotal: ~48.6 audio-minutes, ~$0.405.** Round 1 STT was ~$0.44, so total
AssemblyAI STT is **~$0.85**. Adding the **~$0.06** LLM Gateway estimate gives **~$0.91
overall**, well under the $10 cap. The $0.06 covers round-1 requests only: the app path and
the judge do not record token usage, so full round-2 gateway spend cannot be reconstructed
from the artifacts. The two round-2 sweeps that do record usage (119.6k input / 2.3k output
on gemma-4-31b; 119.1k / 2.1k on qwen3.5-4b-32k-fast) add **~$0.03** at list rates, so the
artifact-backed total is at least **~$0.94** before unrecorded round-2 calls. Deepgram TTS
(~$0.38) is separate and not AssemblyAI.

## Round 3 (current prompt re-run + held-out corpus)

| run | mode | audio min | est. cost $ | note |
|---|---|---:|---:|---|
| app_v9 | sync live | 9.05 | 0.0754 | pre-fix 29-clip regression, warm |
| hard_v9 | sync live | 5.41 | 0.0451 | pre-fix 18-clip hard, warm |
| heldout_v9 | sync live | 4.64 | 0.0387 | pre-fix 20-clip held-out, warm |
| heldout_bullets_probe | sync live | 0.23 | 0.0019 | ho-bullets ASR retry, same audio |
| heldout_v9 bullets rerun | sync live | 0.23 | 0.0019 | ho-bullets after TTS voice fix |
| app_v10 | sync live | 9.05 | 0.0754 | broad-rule prompt, regression |
| hard_v10 | sync live | 5.41 | 0.0451 | broad-rule prompt, hard |
| heldout_v10 partial | sync live | 0.52 | 0.0043 | broad-rule, stopped after 2 clips |
| app_v11 | sync live | 9.05 | 0.0754 | final prompt, regression, warm |
| hard_v11 | sync live | 5.41 | 0.0451 | final prompt, hard, warm |
| heldout_v11 | sync live | 4.64 | 0.0387 | final prompt, 20-clip held-out, warm |
| **round-3 subtotal** | | **53.64** | **0.4470** | |

Round 3 adds **~$0.45** of AssemblyAI STT (pre-fix, broad-rule and final suites plus two
single-clip retries), bringing artifact-backed STT spend to roughly **$1.30**. The 20-clip
held-out corpus cost ~**$0.113** of Deepgram TTS (3,588 characters for the initial
generation plus 175 characters to regenerate `ho-bullets` with a different voice). LLM
Gateway cleanup and judge calls are not token-recorded by the app path or `judge.py`; at
roughly 185 cleanup calls and 265 judge calls (including the corrected-ideal hard re-judge)
they are about **$0.11** at list rates. Total spend remains well under the $10 cap.

Round 3b (cleanup-only prompt iteration, §9.6 in `RESULTS.md`): 97 gemma-4-31b gateway calls
(three hard runs, two held-out runs and three single-clip probes), roughly 0.25M tokens,
about **$0.02-0.03** at list rates. No STT, TTS or judge calls.
