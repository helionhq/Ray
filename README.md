# Ray

Fast, clean dictation for Windows 10/11. Press your dictation shortcut (**Right Alt** by default), speak, press it again. Ray transcribes while you speak, cleans up the text, and pastes it into whatever you were typing in.

Built with Tauri 2 (Rust backend, React + TypeScript frontend). The floating bar is a web port of the Dot scope HUD from [Hex](https://github.com/anomalyco/hex).

## What it does

- **The dictation shortcut toggles recording.** It is configurable in Settings and defaults to Right Alt. Supported forms are a single modifier (either side of Alt, Ctrl, Shift, or Win), a single safe key (F1–F24, Pause, Scroll Lock, Insert, the navigation keys, and media keys), or one or more modifiers plus a key (for example Ctrl + Shift + Space or Alt + D; Esc is reserved for cancelling and letters or digits need a modifier). A low-level keyboard hook swallows the shortcut's edges so the target app never sees them: a modifier shortcut swallows both edges of the modifier (so no menu bar or Start menu), and a combo swallows only its trigger key. Pressing another key while a modifier shortcut is held cancels the recording and replays the chord with the modifier down, so AltGr characters (`@`, `€`) and Alt+Tab still work. A bare Win tap is suppressed so it does not open Start. **Esc** cancels.
- **Streaming is always on.** Ray sends 16 kHz mono PCM to Ray's API while you talk (`/v1/stt/sync-live`, proxied to AssemblyAI Sync live), so stopping only waits for the tail and final decode (~0.5 s typical). If the live request fails, Ray falls back to Sync batch, then a server-side v2 batch proxy, using the locally buffered WAV.
- **Cleanup** sends the transcript through Ray's OpenAI-compatible cleanup proxy (`/v1/cleanup/chat/completions`). Structured is the only mode: it rewrites for flow and can add paragraphs and lists. If cleanup fails, the raw transcript is pasted rather than lost.
- **Paste** saves the clipboard, sets the cleaned text, sends Ctrl+V to the focused window, then restores the clipboard. Restore timing is adaptive (longer for Electron, Office, and browsers) and is skipped if anything else changed the clipboard meanwhile, so slow targets never paste the old contents. Transient dictation text is excluded from Win+V clipboard history and cloud clipboard. If the focused window is elevated, Ray says so instead of silently failing.
- **History**, **dictionary**, **account**, and **settings** live in a monochrome Notion/Linear-style window. Closing it hides it; Ray stays in the tray. History is kept locally on this PC. Ray's servers never store or log your audio or transcripts; cleanup sends the transcript, your dictionary terms, and the foreground app's name to AssemblyAI for processing.
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

## Account and sign-in

Ray is a paid product with a free Starter plan (1,000 words per week) and Pro.
There are no provider API keys to enter: the desktop app holds a single Ray
device token and the Worker owns the upstream AssemblyAI key.

Sign in from the main window. Ray opens the browser at
`{SITE_URL}/desktop/sign-in` with a PKCE-style state/challenge pair; after you
finish signing in there, the browser hands back to the app through
`ray://auth/callback`, and the app exchanges the one-time code for a device
token. The token is stored in **Windows Credential Manager** under service
`ray`, account `session`; nothing is written to the repo or baked into the
binary. Signing out revokes it on the server and deletes the local copy.

On startup Ray also removes credentials left behind by the retired AssemblyAI,
Vercel, and Groq integrations.

### Local development

The API origin is `api.base_url` in `src-tauri/config/pipeline.json`
(`https://ray.helionhq.com`) and the public site origin is `api.site_url`
(which defaults to the effective API origin). Point them at Wrangler with
either a runtime override or the environment:

```sh
RAY_API_BASE=http://127.0.0.1:8787 RAY_SITE_URL=http://127.0.0.1:8787 pnpm tauri dev
```

`RAY_SITE_URL` controls only the browser sign-in hand-off (`/desktop/sign-in`);
the device token still goes to `RAY_API_BASE`.

`RAY_DEVICE_TOKEN` is accepted as a development fallback when no stored session
exists (debug builds, or any headless selftest). It is ignored by release
builds outside the selftest path.

## The Ray API

Every request uses `Authorization: Bearer ray_…` and goes to the same origin:

| purpose | endpoint |
|---|---|
| live STT | `POST {api}/v1/stt/sync-live` (streamed multipart, `X-AAI-Model`) |
| batch STT | `POST {api}/v1/stt/sync` (multipart) |
| batch fallback | `POST {api}/v1/stt/batch` (WAV body; `X-Ray-Keyterms`, `X-Ray-Speech-Models`; returns `{text}`) |
| cleanup | `POST {api}/v1/cleanup/chat/completions` (OpenAI-compatible) |
| pre-warm | `GET {api}/v1/ping` |
| account | `GET {api}/api/me` |
| sign-in | `POST {api}/api/desktop/token`, `POST {api}/api/desktop/signout` |
| billing | `POST {api}/api/billing/checkout`, `POST {api}/api/billing/portal` |

Errors are classified by their JSON `error` code, never by HTTP status alone,
because the Worker maps upstream failures to `502 upstream_error` /
`503 upstream_busy` and enforces a per-user STT concurrency cap with
`429 too_many_requests`. Only these codes change the dictation flow:

- `402 quota_exceeded` (Starter weekly limit) and `429 fair_use` (Pro fair-use
  cap) skip the batch fallback and show the limit message. Whatever was already
  transcribed is still pasted and saved in History, including a live session
  that hit the limit on a later rollover segment.
- `401 unauthorized` clears the local session and asks you to sign in.
- `upstream_error`, `upstream_busy`, `too_many_requests`, and every other code
  follow the normal fallback path. Cleanup failures of any kind (including
  402/429/403 `no_cleanup_grant`) paste the raw transcript instead of losing it.

If the cached account already says Starter is at its limit, Ray refuses to
start recording and opens Account — unless the cached week has already reset,
in which case it refreshes `/api/me` first (and allows the recording if that
refresh fails).

## Swapping the prompt or models

Everything lives in these files:

- `src-tauri/prompts/structured.md` — the cleanup system prompt. Supports `{{DICTIONARY}}`, `{{KNOWN_NAMES}}`, `{{APP_NAME}}`, and `{{TRANSCRIPT}}`.
- `src-tauri/config/pipeline.json` — API origin, STT models and limits, cleanup models, temperature, retries, timeouts, and the built-in known-names list.

Rebuild after editing them, or override at runtime without a rebuild by placing `structured.md` and/or `pipeline.json` in `%APPDATA%\com.helion.ray\` and pressing **Settings → About → Reload config**. Runtime overrides use the same schema as the checked-in files; fields you omit keep their defaults.

The embedded cleanup settings are the researched Structured values:

```json
"cleanup": {
  "temperature": 0.0,
  "max_tokens": 3000,
  "timeout_ms": 8000,
  "hedge_after_ms": 4000,
  "providers": [{ "id": "ray", "model": "gemma-4-31b" }]
}
```

`cleanup.providers` is an ordered list of `{ "id", "model", "extra_body"? }`.
All of them go to Ray's cleanup proxy; the `model` id is passed through
verbatim. A second entry keeps the existing hedge/fallback behavior.

## Headless verification

A real WAV can be run through the shipping code paths:

```sh
# Sync batch STT + cleanup
RAY_DEVICE_TOKEN=ray_… cargo run --manifest-path src-tauri/Cargo.toml -- --selftest path/to/16k-mono.wav

# Live STT (Sync live) + cleanup
RAY_DEVICE_TOKEN=ray_… cargo run --manifest-path src-tauri/Cargo.toml -- --selftest-stream path/to/16k-mono.wav

# Any-rate audio: run it through the real capture resampler, then live STT + cleanup
RAY_DEVICE_TOKEN=ray_… cargo run --manifest-path src-tauri/Cargo.toml -- --selftest-resample path/to/48k-mono.wav

# Against a local Worker
RAY_API_BASE=http://127.0.0.1:8787 RAY_DEVICE_TOKEN=ray_… cargo run ... -- --selftest ...

# Force cleanup to fail, exercising the raw-transcript fallback
RAY_TEST_FORCE_FALLBACK=1 cargo run ... --selftest ...

# Real microphone capture for ~2.5 seconds (sample count + ambient level)
cargo run --manifest-path src-tauri/Cargo.toml -- --selftest-mic
```

The selftest uses the stored device token when one exists, otherwise
`RAY_DEVICE_TOKEN`; `RAY_API_BASE` overrides the configured origin. It prints
`stop_to_transcript_ms` and `cleanup_ms`, and falls back to batch if the live
request fails, exactly like the app. Set `RAY_TEST_WARM=1` to pre-warm the API
connection before STT (simulating a recording), and `RAY_TEST_REPEAT_CLEANUP=1`
to measure a second, already-warm cleanup call. `RAY_TEST_FORCE_FALLBACK=1`
makes every cleanup model fail so the raw-transcript path is exercised.

A 16 kHz mono WAV can be generated with Deepgram:

```sh
curl -X POST "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=16000&container=wav" \
  -H "Authorization: Token $DEEPGRAM_API_KEY" -H "Content-Type: application/json" \
  -d '{"text":"Um, test the Ray dictation pipeline."}' -o test.wav
```

In debug builds, `RAY_TEST_PCM=/path/to/raw-16k-mono.pcm` replaces the microphone with that PCM stream, so the entire hotkey → bar → STT → cleanup → paste path can be exercised without speaking. `RAY_TEST_MAX_RECORDING_SECONDS=N` lowers the automatic recording cap (debug only) to exercise the auto-stop path.

## Architecture

```
src-tauri/src/
  hotkey.rs      WH_KEYBOARD_LL thread: configurable shortcut toggle + capture, Esc cancel, chord recovery
  audio.rs       cpal capture, mono downmix, low-pass + resample to 16 kHz PCM16, level meter
  auth.rs        browser sign-in, PKCE state/challenge, deep links, device token, /api/me cache
  api.rs         API origin/URL helpers and typed quota/auth errors
  stt.rs         Sync live through the Ray API, Sync batch, server-side v2 batch fallback
  cleanup.rs     Structured cleanup through the Ray API with retry/backoff/hedging
  pipeline.rs    recording session state machine, quota/auth gating, bar/paste orchestration
  paste.rs       clipboard save/restore + Ctrl+V via SendInput
  windows_util.rs bar window styles/positioning, foreground app, launch-at-login
  store.rs       history, dictionary, settings (JSON in %APPDATA%)
  commands.rs    Tauri commands for the two webviews
  config.rs      embedded config + prompt and runtime overrides

src/
  App.tsx, pages/     history, dictionary, account, settings, sign-in
  bar/                Dot scope canvas simulation + bar state
```

The bar window is a separate Tauri window (`bar.html`). It is styled with `WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW`, shown with `SW_SHOWNOACTIVATE`, and positioned in the work area of the monitor that owns the foreground window. Toolbar/window focus is never taken, so the paste target stays focused. Signed-out and quota messages reuse the bar's existing `error` phase; the bar's look is unchanged.

Sign-in deep links are registered for installed builds through `tauri.conf.json`
(`ray://`) and at runtime with `register_all()` in debug builds. The
single-instance plugin forwards links from a second process to the running app,
so a `ray://auth/callback` that launches Ray while it is already in the tray is
still delivered.

## Known limits

- Sync live accepts up to 120 s of audio per request; longer dictations roll over to a new live request and the segment transcripts are concatenated. If the live path fails, the batch endpoint is used.
- A single recording stops automatically at 5 minutes, the size of the local batch-fallback buffer. The bar tells you when that happens.
- Starter is capped at 1,000 words per week (resets Monday 00:00 UTC). Pro is unlimited under a fair-use cap; if it is hit, dictation stops with a short message until the week resets. A dictation that crosses the limit is allowed to finish and is counted.
- Pasting into elevated (admin) windows is blocked by Windows UIPI. Ray detects this and copies the text to the clipboard with a clear message instead of silently doing nothing.
- With the default Right Alt shortcut on a layout where Right Alt is AltGr, typing an AltGr character starts and immediately cancels a dictation (a brief bar flicker), but the character itself is replayed correctly. Choose another shortcut in Settings if that is distracting.
- When Win is the shortcut, Ray swallows both of its edges so a bare tap does not open Start. Windows still handles Win+L (lock) itself, so that combination may lock the PC even while Win is the dictation shortcut.
- Multi-monitor placement is implemented but only verified on a single monitor.
