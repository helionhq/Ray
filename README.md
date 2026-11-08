# Ray

Fast, clean dictation for Windows 10/11. Press your dictation shortcut (**Right Alt** by default), speak, press it again. Ray transcribes while you speak, cleans up the text, and pastes it into whatever you were typing in.

Built with Tauri 2 (Rust backend, React + TypeScript frontend). The floating bar is a web port of the Dot scope HUD from [Hex](https://github.com/anomalyco/hex).

## What it does

- **The dictation shortcut toggles recording.** It is configurable in Settings and defaults to Right Alt. Supported forms are a single modifier (either side of Alt, Ctrl, Shift, or Win), a single safe key (F1–F24, Pause, Scroll Lock, Insert, the navigation keys, and media keys), or one or more modifiers plus a key (for example Ctrl + Shift + Space or Alt + D; Esc is reserved for cancelling and letters or digits need a modifier). A low-level keyboard hook swallows the shortcut's edges so the target app never sees them: a modifier shortcut swallows both edges of the modifier (so no menu bar or Start menu), and a combo swallows only its trigger key. Pressing another key while a modifier shortcut is held cancels the recording and replays the chord with the modifier down, so AltGr characters (`@`, `€`) and Alt+Tab still work. A bare Win tap is suppressed so it does not open Start. **Esc** cancels.
- **AssemblyAI Sync live** streams 16 kHz mono PCM while you talk. Stopping leaves only the tail and final decode (~0.5 s typical). If live fails, Ray falls back to Sync batch, then the asynchronous v2 batch API, using the locally buffered WAV.
- **Cleanup** sends the transcript through an OpenAI-compatible chat endpoint on the AssemblyAI LLM Gateway (same key as STT). Pick a mode in Settings: **Clean** removes fillers and fixes grammar without reordering, while **Structured** rephrases for flow and can add paragraphs and lists. If cleanup fails, the raw transcript is pasted rather than lost.
- **Paste** saves the clipboard, sets the cleaned text, sends Ctrl+V to the focused window, then restores the clipboard. Restore timing is adaptive (longer for Electron, Office, and browsers) and is skipped if anything else changed the clipboard meanwhile, so slow targets never paste the old contents. Transient dictation text is excluded from Win+V clipboard history and cloud clipboard. If the focused window is elevated, Ray says so instead of silently failing.
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
pnpm tauri build        # installer; signs updater artifacts, needs the signing key
pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'  # unsigned local installer
pnpm tauri build --no-bundle   # executable only
```

`pnpm tauri build` signs the updater artifact, so it needs `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Without them, pass the `createUpdaterArtifacts: false` override above; the release workflow builds that way and signs the installer in its publish job.

The Rust side can be checked independently with `cargo check --manifest-path src-tauri/Cargo.toml`; run unit tests with `cargo test --manifest-path src-tauri/Cargo.toml --lib`.

## Releases

Every merge into `main` publishes a signed Windows release and bumps the patch
version; installed apps pick it up automatically. See [RELEASING.md](RELEASING.md)
for the pipeline, manual releases, and the signing key.

## Keys

Enter keys in **Settings → Transcription / Cleanup**. They are stored in **Windows Credential Manager** under service `ray`, and are never written to the repo or baked into the binary.

For development and headless tests, the app also accepts environment variables when no stored key exists:

- `ASSEMBLYAI_API_KEY`

Put it in a local `.env` (gitignored) and export it before launching, or set it in the shell. The AssemblyAI key powers both STT and the cleanup model.

## Swapping the prompt or models

Everything lives in these files:

- `src-tauri/prompts/cleanup.md` — the Clean mode system prompt. Supports `{{DICTIONARY}}`, `{{KNOWN_NAMES}}`, `{{APP_NAME}}`, and `{{TRANSCRIPT}}`.
- `src-tauri/prompts/structured.md` — the Structured mode system prompt, with the same placeholders.
- `src-tauri/config/pipeline.json` — STT mode/model/endpoints, cleanup provider order, models, temperature, retries, timeouts, per-mode overrides, and the built-in known-names list.

Rebuild after editing them, or override at runtime without a rebuild by placing `cleanup.md`, `structured.md`, and/or `pipeline.json` in `%APPDATA%\com.helion.ray\` and pressing **Settings → About → Reload config**. Runtime overrides use the same schema as the checked-in files.

To use a different STT protocol, set `stt.mode` to `sync_live` (default) or `websocket`. To add an LLM provider, add an entry to `cleanup.providers` with an OpenAI-compatible `base_url`, `model`, and one of the `api_key_secret` values (`assemblyai`, `vercel`) and the matching key in Settings.

Structured can override any of the base cleanup fields without touching Clean:

```json
"cleanup": {
  "modes": {
    "structured": {
      "model": "gemma-4-31b",
      "temperature": 0.2,
      "max_tokens": 4000,
      "timeout_ms": 8000,
      "hedge_after_ms": 2500
    }
  }
}
```

Unset fields inherit the base `cleanup` config, and `model` is passed through verbatim to the primary provider (the AssemblyAI gateway also serves non-Gemma ids).

## Headless verification

A real WAV can be run through the shipping code paths:

```sh
# Sync batch STT + cleanup
cargo run --manifest-path src-tauri/Cargo.toml -- --selftest path/to/16k-mono.wav

# Live STT (Sync live by default) + cleanup
cargo run --manifest-path src-tauri/Cargo.toml -- --selftest-stream path/to/16k-mono.wav

# Run the same clip through the Structured cleanup mode
cargo run --manifest-path src-tauri/Cargo.toml -- --selftest-stream path/to/16k-mono.wav --mode structured

# Any-rate audio: run it through the real capture resampler, then live STT + cleanup
cargo run --manifest-path src-tauri/Cargo.toml -- --selftest-resample path/to/48k-mono.wav

# Force the WebSocket STT implementation instead
RAY_STT_MODE=websocket cargo run ... -- --selftest-stream ...

# Force cleanup to fail, exercising the raw-transcript fallback
RAY_TEST_FORCE_FALLBACK=1 cargo run ... --selftest ...

# Real microphone capture for ~2.5 seconds (sample count + ambient level)
cargo run --manifest-path src-tauri/Cargo.toml -- --selftest-mic
```

The selftest prints `stop_to_transcript_ms` and `cleanup_ms`, and falls back to batch if the live request fails, exactly like the app. `--mode structured` (or `RAY_CLEANUP_MODE=structured`) selects the Structured mode; it defaults to Clean. Set `RAY_TEST_WARM=1` to pre-warm the cleanup connection before STT (simulating a recording), and `RAY_TEST_REPEAT_CLEANUP=1` to measure a second, already-warm cleanup call.

A 16 kHz mono WAV can be generated with Deepgram:

```sh
curl -X POST "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=16000&container=wav" \
  -H "Authorization: Token $DEEPGRAM_API_KEY" -H "Content-Type: application/json" \
  -d '{"text":"Um, test the Ray dictation pipeline."}' -o test.wav
```

In debug builds, `RAY_TEST_PCM=/path/to/raw-16k-mono.pcm` replaces the microphone with that PCM stream, so the entire hotkey → bar → STT → cleanup → paste path can be exercised without speaking. `RAY_TEST_IGNORE_STORED_KEYS=1` makes the key lookup skip Windows Credential Manager (debug only) so the first-run and invalid-key paths can be tested with the environment-variable fallback. `RAY_TEST_MAX_RECORDING_SECONDS=N` lowers the automatic recording cap (debug only) to exercise the auto-stop path.

## Architecture

```
src-tauri/src/
  hotkey.rs      WH_KEYBOARD_LL thread: configurable shortcut toggle + capture, Esc cancel, chord recovery
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
- A single recording stops automatically at 5 minutes, the size of the local batch-fallback buffer. The bar tells you when that happens.
- Pasting into elevated (admin) windows is blocked by Windows UIPI. Ray detects this and copies the text to the clipboard with a clear message instead of silently doing nothing.
- With the default Right Alt shortcut on a layout where Right Alt is AltGr, typing an AltGr character starts and immediately cancels a dictation (a brief bar flicker), but the character itself is replayed correctly. Choose another shortcut in Settings if that is distracting.
- When Win is the shortcut, Ray swallows both of its edges so a bare tap does not open Start. Windows still handles Win+L (lock) itself, so that combination may lock the PC even while Win is the dictation shortcut.
- Multi-monitor placement is implemented but only verified on a single monitor.
