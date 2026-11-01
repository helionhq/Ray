# Ray

Fast, clean dictation for Windows 10/11. Press **Right Alt**, speak, press it again. Ray transcribes while you speak, cleans up the text, and pastes it into whatever you were typing in.

Built with Tauri 2 (Rust backend, React + TypeScript frontend). The floating bar is a web port of the Dot scope HUD from [Hex](https://github.com/anomalyco/hex).

## What it does

- **Right Alt toggles recording.** A low-level keyboard hook swallows both edges of the modifier so the target app never opens its menu bar. Pressing another key while Right Alt is held cancels the recording and lets that key through. **Esc** cancels.
- **AssemblyAI Sync live** streams 16 kHz mono PCM while you talk. Stopping leaves only the tail and final decode (~0.5 s typical). If live fails, Ray falls back to Sync batch, then the asynchronous v2 batch API, using the locally buffered WAV.
- **Cleanup** sends the transcript through an OpenAI-compatible chat endpoint. Default chain: `gemma-4-31b` on the AssemblyAI LLM Gateway (same key as STT) → `openai/gpt-oss-120b` on Groq → Vercel AI Gateway if you add a key. If every provider fails, the raw transcript is pasted rather than lost.
- **Paste** saves the clipboard, sets the cleaned text, sends Ctrl+V to the focused window, then restores the clipboard.
- **History**, a **dictionary** of preferred spellings, and **keys/settings** live in a monochrome Notion/Linear-style window. Closing it hides it; Ray stays in the tray.
- The bar is always-on-top, click-through, non-focusable, hidden from the taskbar, and sits above the taskbar of the monitor with the focused window.

## Requirements

- Windows 10/11, WebView2 (present on current Windows)
- Node 20+ and pnpm
- Rust (stable)

## Run and build

```sh
pnpm install
pnpm tauri dev          # Vite + the app
pnpm tauri build        # installer (NSIS)
pnpm tauri build --no-bundle   # executable only
```

The Rust side can be checked independently with `cargo check --manifest-path src-tauri/Cargo.toml`; run unit tests with `cargo test --manifest-path src-tauri/Cargo.toml --lib`.

## Keys

Enter keys in **Settings → Transcription / Cleanup**. They are stored in **Windows Credential Manager** under service `ray`, and are never written to the repo or baked into the binary.

For development and headless tests, the app also accepts environment variables when no stored key exists:

- `ASSEMBLYAI_API_KEY`
- `GROQ_API_KEY`

Put them in a local `.env` (gitignored) and export it before launching, or set them in the shell. The AssemblyAI key powers both STT and the primary cleanup model.

## Swapping the prompt or models

Everything lives in two files:

- `src-tauri/prompts/cleanup.md` — the cleanup system prompt. Supports `{{DICTIONARY}}`, `{{KNOWN_NAMES}}`, `{{APP_NAME}}`, and `{{TRANSCRIPT}}`.
- `src-tauri/config/pipeline.json` — STT mode/model/endpoints, cleanup provider order, models, temperature, retries, timeouts, and the built-in known-names list.

Rebuild after editing them, or override at runtime without a rebuild by placing `cleanup.md` and/or `pipeline.json` in `%APPDATA%\com.helion.ray\` and pressing **Settings → Reload config**. Runtime overrides use the same schema as the checked-in files.

To use a different STT protocol, set `stt.mode` to `sync_live` (default) or `websocket`. To add an LLM provider, add an entry to `cleanup.providers` with an OpenAI-compatible `base_url`, `model`, and one of the `api_key_secret` values (`assemblyai`, `groq`, `vercel`).

## Headless verification

A real WAV can be run through the shipping code paths:

```sh
# Sync batch STT + cleanup
cargo run --manifest-path src-tauri/Cargo.toml -- --selftest path/to/16k-mono.wav

# Live STT (Sync live by default) + cleanup
cargo run --manifest-path src-tauri/Cargo.toml -- --selftest-stream path/to/16k-mono.wav

# Force the WebSocket STT implementation instead
RAY_STT_MODE=websocket cargo run ... -- --selftest-stream ...

# Force the primary cleanup endpoint to fail, to exercise the fallback chain
RAY_TEST_FORCE_FALLBACK=1 cargo run ... --selftest ...

# Real microphone capture for ~2.5 seconds (sample count + ambient level)
cargo run --manifest-path src-tauri/Cargo.toml -- --selftest-mic
```

A 16 kHz mono WAV can be generated with Deepgram:

```sh
curl -X POST "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=16000&container=wav" \
  -H "Authorization: Token $DEEPGRAM_API_KEY" -H "Content-Type: application/json" \
  -d '{"text":"Um, test the Ray dictation pipeline."}' -o test.wav
```

In debug builds, `RAY_TEST_PCM=/path/to/raw-16k-mono.pcm` replaces the microphone with that PCM stream, so the entire hotkey → bar → STT → cleanup → paste path can be exercised without speaking.

## Architecture

```
src-tauri/src/
  hotkey.rs      WH_KEYBOARD_LL thread: Right Alt toggle, Esc cancel, AltGr chord recovery
  audio.rs       cpal capture, mono downmix, low-pass + resample to 16 kHz PCM16, level meter
  stt.rs         AssemblyAI Sync live, WebSocket streaming, Sync batch, v2 batch fallback
  cleanup.rs     OpenAI-compatible cleanup with retry/backoff and provider fallback
  pipeline.rs    recording session state machine and bar/paste orchestration
  paste.rs       clipboard save/restore + Ctrl+V via SendInput
  windows_util.rs bar window styles/positioning, foreground app, launch-at-login
  store.rs       history, dictionary, settings (JSON in %APPDATA%)
  commands.rs    Tauri commands for the two webviews
  config.rs      embedded config + prompt and runtime overrides

src/
  App.tsx, pages/     history, dictionary, settings
  bar/                Dot scope canvas simulation + bar state
```

The bar window is a separate Tauri window (`bar.html`). It is styled with `WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW`, shown with `SW_SHOWNOACTIVATE`, and positioned in the work area of the monitor that owns the foreground window. Toolbar/window focus is never taken, so the paste target stays focused.

## Known limits

- Sync live accepts up to 120 s of audio per request; longer dictations roll over to a new live request and the segment transcripts are concatenated. If the live path fails, the batch endpoint is used.
- Pasting into elevated (admin) windows can be blocked by Windows UIPI.
- On layouts where Right Alt is AltGr, pressing Right Alt alone may be interpreted by the layout; holding it and pressing another key cancels dictation. The modifier itself is not forwarded in that case.
- Groq's free tier has a daily token cap; the app falls back to the next provider or raw text.
- Multi-monitor placement is implemented but only verified on a single monitor.
