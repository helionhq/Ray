# Ray commercial launch: shared contract

This is the single source of truth that every workstream builds against. If you need to
deviate, keep the deviation minimal and record it in your final report.

## Product decisions (fixed)

- Plans: **Starter** (free), **Pro** (paid), and a **14-day no-card Pro trial**.
  Use exactly these names.
  - Starter: **1,000 words per week** (`STARTER_WEEKLY_WORDS`). Week resets
    **every Monday 00:00 UTC**.
  - Pro: **unlimited words**, marketed as unlimited. There is **no weekly word
    cap**. The only hidden Pro cap is **audio time**: `FAIR_USE_WEEKLY_AUDIO_SECONDS`
    (default **25,200** = 7 h/week). Never advertise the number; show a polite
    "fair-use limit reached, resets Monday" message only when it is actually hit.
  - Trial: **14 days of Pro, no card**. It starts at the user's **first successful
    desktop sign-in** (`POST /api/desktop/token`), only if the account has never
    had a subscription row, `trial_started_at` is null, the account is not
    free-blocked, and a valid `device_id` was supplied. It never starts on
    site-only sign-up. During the trial the account resolves as **Pro (trial)**
    with the hidden trial audio budget `TRIAL_WEEKLY_AUDIO_SECONDS` (default
    **10,800** = 3 h/week). Afterwards it is Starter. A paid subscription takes
    precedence over the trial at all times.
  - Audio abuse budget: AssemblyAI bills audio time, not words, so the Worker also
    meters the bytes streamed to it. Hidden weekly caps: Starter **60 minutes**
    (`STARTER_WEEKLY_AUDIO_SECONDS`), trial **3 hours**, Pro **7 hours**. 1,000
    words is roughly 8-10 minutes of speech, so these only catch silent or
    near-empty audio abuse. Never advertise them; over a cap STT returns the
    normal `quota_exceeded` (Starter) / `fair_use` (Pro, trial) shapes.
  - Per-PC free limit: the desktop sends a one-way hashed device identifier. The
    first **three distinct accounts** ever seen on a PC are unaffected; the
    **fourth and later** are marked `free_blocked_at`. A free-blocked account can
    sign in but gets no trial and, without a paid subscription, every STT request
    answers `402 device_limit`. A paid Pro subscription works normally.
  - Pro price: **$9/month billed monthly**, or **$7/month billed annually
    ($84/year)**, badge **"Save 22%"**.
- Auth: **Clerk**, with **email** (code or password, whichever Clerk defaults to) and **Google**.
- Payments: **Creem** (https://docs.creem.io). Two Creem products: Pro Monthly, Pro Annual.
- Backend: **Cloudflare Workers + D1**, deployed together with the public landing page as
  **one Worker** (Workers Static Assets for the site, `/api/*` and `/v1/*` handled in code).
- Privacy: audio and transcripts **pass through** the Worker in memory to AssemblyAI and are
  **never stored or logged**. D1 holds only users, device sessions, a one-way hashed
  device identifier (for the per-PC free limit), subscriptions, and weekly **word counts
  and audio-second counters**. The raw hardware id is never received. Do not
  `console.log` request or response bodies anywhere.
- The user's own AssemblyAI key is gone. The server holds `ASSEMBLYAI_API_KEY` as a secret.
- Desktop: no "stream while I speak" toggle (streaming is always on); no Clean mode
  (Structured is the only cleanup mode, with no selector); no API key fields; the
  dictation shortcut is configurable (default Right Alt).
- The floating bar's look must stay an exact copy of Hex's Dot scope HUD. Do not restyle the
  bar. New states (signed out, limit reached) reuse the bar's existing message/error
  mechanism.

## Repository layout

pnpm workspace. The desktop app stays at the repo root (so the release workflow is untouched).

```
pnpm-workspace.yaml        packages: ["web"]   (root package stays the desktop app)
web/                       package name "@ray/web"
  package.json
  wrangler.jsonc           one Worker: main = worker/index.ts, assets = ./dist (SPA fallback),
                           d1_databases binding "DB", run_worker_first for /api/* and /v1/*
  migrations/              D1 SQL migrations (0001_init.sql, ...)
  worker/                  Hono app: API, proxy, Clerk verification, Creem, quota
  src/                     Vite + React landing site and account pages (Clerk React)
  index.html, vite.config.ts, tsconfig*.json
  README.md                setup: Clerk, Creem, D1, secrets, deploy
```

Ownership while building in parallel:
- **web-api** owns `web/worker/**`, `web/migrations/**`, `web/wrangler.jsonc`, `web/README.md`,
  `pnpm-workspace.yaml`, and the initial `web/package.json` / `web/tsconfig*.json`.
- **web-site** owns `web/src/**`, `web/index.html`, `web/vite.config.ts`, `web/public/**`.
  It may also create `web/package.json` if missing; the merge step reconciles dependencies.
- **desktop-core** owns everything under `src-tauri/` and `src/` except the hotkey work below.
- **desktop-hotkey** owns `src-tauri/src/hotkey.rs`, plus *additive* changes to
  `store.rs` (a `hotkey` setting), `commands.rs` (hotkey commands), `lib.rs` wiring, and a
  self-contained Shortcut section component in `src/` that Settings renders.

## Environment / config

Worker vars (wrangler `vars`) and secrets:

| name | kind | meaning |
|---|---|---|
| `SITE_URL` | var | public origin, e.g. `https://ray.helionhq.com` (placeholder until the real domain) |
| `CLERK_PUBLISHABLE_KEY` | var | Clerk publishable key (also exposed to the site as `VITE_CLERK_PUBLISHABLE_KEY`) |
| `CLERK_SECRET_KEY` | secret | Clerk backend key |
| `ASSEMBLYAI_API_KEY` | secret | AssemblyAI key for STT + LLM gateway |
| `CREEM_API_KEY` | secret | Creem API key |
| `CREEM_WEBHOOK_SECRET` | secret | Creem webhook signing secret |
| `CREEM_API_BASE` | var | `https://test-api.creem.io` (test) or `https://api.creem.io` (live) |
| `CREEM_PRODUCT_PRO_MONTHLY` | var | Creem product id |
| `CREEM_PRODUCT_PRO_ANNUAL` | var | Creem product id |
| `STARTER_WEEKLY_WORDS` | var | default `1000` |
| `STARTER_WEEKLY_AUDIO_SECONDS` | var | hidden Starter audio budget, default `3600` (60 min) |
| `FAIR_USE_WEEKLY_AUDIO_SECONDS` | var | hidden Pro audio fair-use cap, default `25200` (7 h) |
| `TRIAL_WEEKLY_AUDIO_SECONDS` | var | hidden trial audio budget, default `10800` (3 h) |
| `CLEANUP_MODELS` | var | comma-separated allowlist, default `gemma-4-31b` |

Desktop: the API origin lives in `src-tauri/config/pipeline.json` as
`"api": { "base_url": "https://ray.helionhq.com" }`, overridable by env `RAY_API_BASE` (dev and
release both; it's not a secret). Local dev: `http://127.0.0.1:8787` (wrangler dev).

## Desktop sign-in (browser hand-off, PKCE-style)

Google blocks OAuth inside embedded webviews, so sign-in happens in the system browser.

1. App generates `state` (random, 32 bytes base64url) and `verifier` (random, 32 bytes
   base64url), computes `challenge = base64url(sha256(verifier))`, keeps both in memory,
   and opens `{SITE_URL}/desktop/sign-in?state=…&challenge=…`.
2. The site page shows Clerk `<SignIn>` (email + Google). Once signed in, it calls
   `POST /api/desktop/authorize` with header `Authorization: Bearer <Clerk session JWT>` and
   JSON `{ state, challenge }`. The Worker returns `{ code, redirect }`, where `code` is a
   one-time code (random, stored **hashed** in D1, expires in 5 minutes) and
   `redirect = "ray://auth/callback?code=…&state=…"`.
3. The page navigates to `redirect` and shows "You're signed in. Return to Ray." with a
   button that re-opens the same `redirect` (browsers sometimes block the first attempt).
4. The app receives the deep link (scheme `ray`, via `tauri-plugin-deep-link`; the
   single-instance plugin forwards argv on Windows), checks `state`, then calls
   `POST /api/desktop/token` with `{ code, verifier, device_id? }`. The Worker checks
   `base64url(sha256(verifier)) == challenge`, consumes the code, and returns
   `{ token, user: { id, email, name } }`. `token` is an opaque device token
   (`ray_` + 32 random bytes base64url), stored **hashed (SHA-256)** in D1 `devices`, with no
   expiry (revocable).
5. The app stores the token in Windows Credential Manager (service `ray`, account `session`).
6. Every desktop request sends `Authorization: Bearer <device token>`.
7. `POST /api/desktop/signout` (device token auth) revokes it. The app deletes it locally too.

### Device id and the per-PC free limit

The desktop reads `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` with
`KEY_READ | KEY_WOW64_64KEY` and sends
`device_id = base64url(SHA-256("ray-device-v1:" + guid))` in the token JSON body. The
raw GUID is never sent or logged. If it cannot be read, `device_id` is omitted: sign-in
still works but the server grants no trial.

The Worker validates `device_id` as a 43-character base64url value and stores
`SHA-256(device_id)` in `devices.device_hash` (indexed). On token exchange it counts the
**distinct `user_id`s that have ever had a row with that `device_hash`** (revoked rows
included, the signing-in user excluded). When that count is already 3, the user is
marked `free_blocked_at`; the first three accounts are never affected, and re-signing in
as an existing account is not a new account. A free-blocked account still signs in, so it
can reach the upgrade buttons, but free STT answers `402 device_limit` and no trial
starts. Only a paid Pro subscription restores dictation.

## HTTP API

All JSON. Errors are `{ "error": "<code>", "message": "<human text>", ...extra }`.

Auth kinds: **clerk** = Clerk session JWT (site); **device** = device token (desktop);
**either** = accept both (try device token first if it starts with `ray_`).

| method | path | auth | purpose |
|---|---|---|---|
| GET | `/v1/ping` | none | 204. Used by the desktop to pre-warm TLS. |
| GET | `/api/me` | either | account + plan + usage (shape below) |
| POST | `/api/desktop/authorize` | clerk | step 2 above |
| POST | `/api/desktop/token` | none | step 4 above |
| POST | `/api/desktop/signout` | device | revoke this device token |
| POST | `/api/devices/revoke-all` | clerk | revoke every device token for the user → `{ "ok": true, "revoked": n }` |
| POST | `/api/billing/checkout` | either | body `{ interval: "monthly" \| "annual" }` → `{ url }` (Creem checkout) |
| POST | `/api/billing/portal` | either | → `{ url }` (Creem customer portal) |
| POST | `/api/webhooks/creem` | Creem signature | subscription lifecycle |
| POST | `/api/webhooks/clerk` | Svix signature | **required** Clerk `user.deleted`: cancels still-renewing Creem subscriptions (best effort), revokes devices, soft-deletes the user; `503 not_configured` when `CLERK_WEBHOOK_SECRET` is unset |
| POST | `/v1/stt/sync-live` | device | streaming proxy for AssemblyAI Sync live |
| POST | `/v1/stt/sync` | device | proxy for AssemblyAI Sync batch |
| POST | `/v1/stt/batch` | device | server-side v2 fallback: body is a WAV (≤ 12 MB); Worker uploads, creates, polls; returns `{ text }` |
| POST | `/v1/cleanup/chat/completions` | device | OpenAI-compatible proxy to the AssemblyAI LLM gateway (cleanup-grant gated) |

`GET /api/me` response:

```json
{
  "user": { "id": "user_…", "email": "a@b.com", "name": "Arham" },
  "plan": "starter",                 // "starter" | "pro" (a trial is "pro")
  "interval": null,                  // null | "monthly" | "annual" (null on a trial)
  "status": null,                    // null | "active" | "trialing" | "past_due" | "canceled" ...
  "cancel_at_period_end": false,
  "current_period_end": null,        // ISO string or null
  "billing_issue": null,             // null | "past_due" | "unpaid" | "paused"
  "trial": null,                     // null | { "ends_at": "2026-11-23T12:00:00Z" }
  "free_blocked": false,             // this PC is over the free-account limit
  "usage": {
    "words_used": 412,
    "words_limit": 1000,             // null for Pro and trial (never expose hidden caps)
    "week_start": "2026-11-02T00:00:00Z",
    "resets_at": "2026-11-09T00:00:00Z"
  }
}
```

While `trial` is non-null, `plan` is `"pro"` but `interval`, `status`,
`cancel_at_period_end`, and `current_period_end` stay null because there is no
subscription. Clients must not present a trial as a paid plan; both UIs show
"Pro trial · N days left" (days computed from `ends_at`) with the upgrade CTAs visible.

Audio seconds are metered into the same weekly usage row but are **not** part of this
response (never expose the audio caps).

`user.email` is always a string (`""` when unknown). `billing_issue` is set for a
non-entitled subscription that still exists and needs a payment-method fix; both UIs
show "Payment issue: update your card" with the portal button instead of the upgrade
CTA, and `/api/billing/checkout` answers `409 { "error": "billing_issue" }`.

A user is **Pro** when they have a subscription with status `active` or `trialing`, or one
that is `canceled`/`scheduled_cancel` but whose `current_period_end` is still in the future.
A paid subscription always wins over the trial. Otherwise, a user whose account never had
a subscription row and whose `trial_started_at` is within the last 14 days is **Pro
(trial)**; everyone else is Starter.

### Common error codes

| status | `error` | meaning |
|---|---|---|
| 400 | `invalid_request`, `invalid_messages`, `model_not_allowed`, `invalid_keyterms`, `invalid_interval`, `invalid_audio` | malformed request |
| 401 | `unauthorized` | invalid/revoked device token or Clerk session; the desktop signs out |
| 402 | `quota_exceeded` | Starter weekly word or audio limit (STT only) |
| 402 | `device_limit` | this PC has used its free accounts and the user has no paid plan (STT only) |
| 403 | `no_cleanup_grant` | no unexpired cleanup grant, or the tagged transcript exceeds the granted words + 25 |
| 409 | `billing_issue`, `already_subscribed`, `no_billing_account`, `checkout_pending` | checkout/portal state |
| 413 | `payload_too_large` (request/audio body) or `message_too_large` (cleanup system/user message) | input over its cap |
| 429 | `fair_use` | Pro or trial hidden audio fair-use cap (STT only); this is a quota, not a rate limit |
| 429 | `too_many_requests` | STT concurrency lease, weekly failure budget, or any rate-limit binding (all rate limits use this code) |
| 500 | `config_error`, `internal_error`, `billing_not_configured` | server configuration or unexpected failure |
| 502 | `upstream_error` | upstream 401/402/403/5xx, unreachable, or timed out |
| 503 | `upstream_busy` | upstream 429 |

`device_limit` is `402 { "error": "device_limit", "message": "This PC has reached its
limit of free accounts. Upgrade to Pro to keep dictating." }`. The desktop classifies it
like `quota_exceeded`: the session stops without a batch fallback, the bar shows "Free
limit reached on this PC", and Account opens.

There is no separate `rate_limited` code: every rate limit is
`429 { "error": "too_many_requests" }`. The desktop classifies Ray errors by the JSON
`error` code, not by status, so all `429 too_many_requests` (and `502`/`503`
`upstream_*`) follow the normal batch-fallback path; only `unauthorized` signs out and
only `quota_exceeded`/`fair_use`/`device_limit` skip the fallback. The site treats any
429 as rate-limited and shows a friendly retry message.

### STT proxy details

- `/v1/stt/sync-live`: the desktop sends exactly what it used to send to
  `https://sync.assemblyai.com/v1/transcribe/live` (streamed multipart body, `X-AAI-Model`
  header, `content-type` with boundary). The Worker checks auth + quota **before** reading
  the body, then forwards the streamed body (`request.body`) upstream under the same 12 MB
  cap as batch, with `authorization: <ASSEMBLYAI_API_KEY>`, forwarding only `content-type`
  and `X-AAI-Model`. It reads the upstream JSON, counts words in `text`, adds them to this
  week's usage, and returns the upstream status + body unchanged (except the upstream-error
  mapping below). Sync live accepts up to 120 s per request; the desktop rolls over to a new
  request at 118 s, and the segment transcripts are joined.
- `/v1/stt/sync`: same, for `https://sync.assemblyai.com/v1/transcribe` (non-streamed body),
  also under the 12 MB cap.
- `/v1/stt/batch`: request body must be the desktop's canonical WAV (RIFF/WAVE,
  PCM format 1, mono, 16 kHz, 16 bit; the declared data length must be ≤ 5 min plus a small
  margin), maximum **12 MB**, enforced on `Content-Length` and chunk by chunk while
  streaming. A non-WAV or over-long body is `400 invalid_audio` before any upstream call;
  over the byte cap is `413 payload_too_large`; an empty body is `400 invalid_audio`.
  Optional header
  `X-Ray-Keyterms` with a JSON array of strings (base64url-encoded JSON, since headers
  can't hold arbitrary Unicode), plus optional `X-Ray-Speech-Models` (comma-separated).
  The Worker does upload → create transcript → poll (700 ms) up to 45 s, counts words, and
  returns `{ "text": "…" }`. The 5-minute desktop recording is 9.6 MB of 16 kHz mono
  PCM16 WAV plus the header, so it fits comfortably.
- Word count = the length of AssemblyAI's `words` array when present; otherwise
  whitespace-separated tokens, with each CJK/Hiragana/Katakana/Hangul character counted
  as one word.
- Quota is checked **before** the upstream call. Going over mid-dictation is allowed (the
  segment that crosses the line is admitted and counted; later live segments are refused
  and the partial text is kept and pasted).
- Concurrency: at most **2 in-flight STT requests per user** (D1 `stt_leases`, 6-minute
  expiry, released in `finally` even when a client stream ends or the handler fails).
  Over the cap: `429 { "error": "too_many_requests" }`. Live rollover segments are
  sequential (the desktop reads one segment's response before starting the next), so a
  normal long dictation never holds two leases. All three STT routes also sit behind the
  per-user `RATE_LIMIT_STT` Workers Rate Limiting binding (30 requests/minute).
- Failed transcriptions count against a generous weekly budget (`stt_failures`, 200 per
  week); over it STT answers `429 { "error": "too_many_requests", "resets_at": … }`.
  A successful response that counted zero words (silence or noise) counts the same way:
  it costs an upstream transcription but consumes no word quota.
- Audio metering: every STT request adds the bytes streamed to AssemblyAI to
  `usage_weeks.audio_seconds` (PCM16 mono 16 kHz = 32,000 bytes/s; the 44-byte WAV
  header is subtracted and the result is rounded up). Sync responses also report
  `audio_duration_ms`, and the larger of that duration and the byte-derived estimate is
  charged. It is charged on every request that reaches upstream, including empty
  transcripts and upstream failures. Starter compares words and audio seconds against
  its limits; Pro and trial have no word cap and compare only audio seconds (7 h and
  3 h respectively). They return the same `402 quota_exceeded` / `429 fair_use` shapes.
  A free-blocked non-paying user gets `402 device_limit` before any quota check.
- Upstream failures never look like Ray errors: upstream 401/402/403/5xx and
  unreachable/timeout become `502 { "error": "upstream_error" }`; an upstream 429 becomes
  `503 { "error": "upstream_busy" }`.

Quota errors (no fallback should be attempted by the desktop for these):
- `402 { "error": "quota_exceeded", "message": "…", "plan": "starter", "words_used", "words_limit", "resets_at" }`
- `429 { "error": "fair_use", "message": "…", "resets_at" }` (Pro or trial over the hidden audio cap)
- `402 { "error": "device_limit", "message": "This PC has reached its limit of free accounts. Upgrade to Pro to keep dictating." }`
- `401 { "error": "unauthorized" }` → desktop treats as signed out.

### Cleanup proxy details

`/v1/cleanup/chat/completions` forwards to
`https://llm-gateway.assemblyai.com/v1/chat/completions` with
`authorization: Bearer <ASSEMBLYAI_API_KEY>`. It no longer checks the weekly quota;
it requires an unexpired **cleanup grant** earned by a just-counted transcription
(see review decision 1). Abuse guards:

- the body must be ≤ 64 KB, at most one system + one user message, system ≤ 24 KB,
  user ≤ 40 KB (`413 message_too_large`, `400 invalid_messages`);
- `model` must be in `CLEANUP_MODELS` (`400 model_not_allowed`); the shipped desktop
  model `gemma-4-31b` is the default allowlist entry;
- only `model`, `messages`, `temperature`, `max_tokens` (clamped to ≤ 4000) and
  `stream: false` are forwarded; every other field is dropped;
- the user message may contain only whitespace and `<transcript>…</transcript>` tags
  (`400 invalid_messages`); untagged text would be forwarded without counting against
  the grant and turn the endpoint into a general-purpose LLM;
- no unexpired grant, no calls left, or more than `grant.words + 25` words inside the
  last user message's `<transcript>…</transcript>` tags → `403 { "error": "no_cleanup_grant" }`;
- upstream failures are mapped to `502 upstream_error` / `503 upstream_busy` like STT.

Cleanup words are **not** counted (STT already counted them).

## D1 schema (minimum)

- `users(id TEXT PK /* clerk user id */, email TEXT, name TEXT, creem_customer_id TEXT, created_at INTEGER, trial_started_at INTEGER, free_blocked_at INTEGER)`
- `devices(id TEXT PK, user_id TEXT, token_hash TEXT UNIQUE, created_at INTEGER, last_used_at INTEGER, revoked_at INTEGER, device_hash TEXT /* indexed, SHA-256 of the desktop's hashed device id */)`
- `auth_codes(code_hash TEXT PK, user_id TEXT, challenge TEXT, state TEXT, expires_at INTEGER, used_at INTEGER)`
- `subscriptions(id TEXT PK /* creem subscription id */, user_id TEXT, product_id TEXT, interval TEXT, status TEXT, current_period_end INTEGER, cancel_at_period_end INTEGER, updated_at INTEGER)`
- `usage_weeks(user_id TEXT, week_start INTEGER /* unix seconds, Monday 00:00 UTC */, words INTEGER, audio_seconds INTEGER /* internal, never in /api/me */, PRIMARY KEY(user_id, week_start))`
- `webhook_events(id TEXT PK, received_at INTEGER)` for idempotency

## Desktop UI expectations

- **Signed out:** the main window shows a clean sign-in screen ("Sign in to start
  dictating", with a button that opens the browser, and a "Waiting for your browser…" state
  with a cancel option). Pressing the dictation shortcut while signed out shows a short bar
  message ("Sign in to Ray to dictate") and opens the main window.
- **Account** (new nav item or a top section of Settings): email, plan badge
  (Starter/Pro/**Pro trial**), a weekly usage meter for Starter ("412 of 1,000 words this
  week · resets Monday"), upgrade buttons ("Upgrade to Pro: $9/mo" and "$7/mo billed
  yearly", which open checkout in the browser), "Manage billing" for paid Pro (portal),
  and "Sign out". While the no-card trial is active the Account page shows "Pro trial · N
  days left" with the upgrade buttons still visible; it must not present the trial as a
  paid subscription. A free-blocked account shows the device-limit message with the
  upgrade buttons. Refresh `/api/me` on window focus, after each dictation, and when a
  `ray://billing/success` deep link arrives (Creem success_url can point to
  `{SITE_URL}/billing/success`, which bounces to `ray://billing/success`).
- **Limit reached:** at recording start, if the cached `/api/me` says Starter is at or
  over the limit, don't record. The bar shows "Weekly limit reached" (or similar, short) and
  the main window opens to Account. A 402/429 from the proxy also ends the session with that
  message and **does not** fall back to batch (`device_limit` included).
- Keep the existing monochrome Notion/Linear visual language. No new color palette.

## Site expectations

- `/` landing page: hero, how it works (press shortcut, speak, it pastes), features (live
  transcription, Structured cleanup, dictionary, works in any app, privacy: "we never store
  your audio or transcripts"), pricing (Starter / Pro with monthly/annual toggle), FAQ,
  footer. Download CTA → `https://github.com/helionhq/Ray/releases/latest`.
- `/sign-in`, `/sign-up` (Clerk components), `/desktop/sign-in` (the hand-off page),
  `/account` (plan, usage, upgrade/manage billing), `/billing/success`, `/privacy`, `/terms`
  (reasonable placeholder text clearly marked for legal review).
- Visual language: monochrome, Geist / Geist Mono, generous whitespace, Linear/Notion
  restraint, matching the desktop app's look. Responsive down to 360px.

## Review-round decisions (implemented)

**Status: implemented.** These decisions are binding, and the commercial-launch branch
implements every one of them; the HTTP API section above was updated to match the built
API. Where a decision names a cap or code, that value is the shipped behaviour.

1. **Cleanup grants (replaces the quota check on cleanup).** `/v1/cleanup/chat/completions` no longer
   checks the weekly quota. Instead it requires an unexpired *cleanup grant* earned by a
   just-counted transcription. D1 table `cleanup_grants(user_id TEXT PK, words INTEGER,
   calls_left INTEGER, expires_at INTEGER)`. Every STT response that counted words upserts the grant:
   if expired, reset to `words = counted`; otherwise `words += counted`; `calls_left = min(calls_left + 6, 30)`;
   `expires_at = now + 15 min`. Cleanup: atomically decrement `calls_left` where `calls_left > 0 AND
   expires_at > now`, and reject if the `<transcript>…</transcript>` content in the last user message
   has more than `grant.words + 25` words. On failure, return `403 { error: "no_cleanup_grant" }`. The
   desktop treats that like any other cleanup failure (paste the raw transcript). This means the
   segment that crosses the limit is transcribed and gets cleaned up, and cleanup can't be
   used as a general LLM.
2. **Cleanup body whitelist.** Forward only `model`, `messages`, `temperature`, `max_tokens`
   (clamped ≤ 4000), and `stream: false`. Drop everything else (`n`, `max_completion_tokens`, tools…).
   Max 2 messages (system + user); system ≤ 24 KB, user ≤ 40 KB. The desktop truncates its
   dictionary so the expanded Structured prompt stays under the system cap.
3. **Per-user STT concurrency lease.** At most 2 in-flight STT requests per user (D1 `stt_leases`
   with a 6-min expiry, released in `finally`). Over the cap: `429 { error: "too_many_requests" }`.
   STT routes also use the per-user `RATE_LIMIT_STT` rate-limit binding, and a zero-word
   transcription (silence) counts against the weekly failure budget.
4. **Upstream errors never look like Ray errors.** The Worker maps any upstream 401/402/403/429 (and
   5xx/timeouts) to `502 { error: "upstream_error" }` (or `503 { error: "upstream_busy" }` for upstream 429).
   The desktop classifies Ray errors **by JSON `error` code** (`unauthorized`, `quota_exceeded`, `fair_use`,
   `too_many_requests`), not by status alone. Only `unauthorized` signs out; only `quota_exceeded` /
   `fair_use` skip the batch fallback. `upstream_*` and `too_many_requests` follow the normal
   fallback path.
5. **Mid-dictation limit on live rollover.** If a later sync-live segment gets `quota_exceeded`/`fair_use`,
   keep the segments already transcribed (return the partial text and paste it), then show the limit
   message.
6. **STT input cap:** 12 MB on every STT route (`sync-live`, `sync`, `batch`), Content-Length
   check plus a streamed cap, streamed upload to AssemblyAI, no `arrayBuffer()` of unbounded input.
   `/v1/stt/batch` validates the canonical 16 kHz mono PCM16 WAV header (≤ 5 min of declared
   data) before any upstream call.
7. **Word counting:** prefer the length of AssemblyAI's `words` array when present; otherwise count
   whitespace tokens, with each CJK/Hiragana/Katakana/Hangul character counted as one word.
8. **Billing integrity:** only `CREEM_PRODUCT_PRO_MONTHLY` / `CREEM_PRODUCT_PRO_ANNUAL` grant Pro;
   `refund.created` and `dispute.created` revoke entitlement immediately (status `revoked`, never
   entitled); webhook idempotency is recorded **after** the state change is applied (same D1 batch);
   no email-based user mapping (metadata.user_id, then creem_customer_id only); a missing
   `CREEM_WEBHOOK_SECRET` fails closed; terminal statuses win `updated_at` ties.
9. **`/api/me` additions:** `user.email` is never null (empty string if unknown). New field
   `billing_issue: null | "past_due" | "unpaid" | "paused"` for a non-entitled subscription that still
   exists and needs a payment-method fix. When `billing_issue` is set, both UIs show "Payment issue:
   update your card" with the portal button instead of the upgrade CTA, and `/api/billing/checkout`
   returns `409 { error: "billing_issue" }`.
10. **Devices:** `POST /api/devices/revoke-all` (clerk auth) revokes every device token for the user;
    the site's Account page has "Sign out all devices".
11. **Hand-off consent:** `/desktop/sign-in` never auto-authorizes. Signed in, it shows "Continue as
    <email>" (an explicit click calls authorize) plus "Use a different account" (Clerk sign-out, then
    show `<SignIn>` again, keeping the params).
12. **Clerk verification fails closed:** an invalid/empty `SITE_URL` is a 500 config error, never
    an empty `authorizedParties`.
13. **Site security headers:** `web/public/_headers` sets frame-ancestors none / X-Frame-Options DENY,
    nosniff, Referrer-Policy, HSTS, and a CSP compatible with Clerk (its frontend API domain, img.clerk.com,
    challenges.cloudflare.com for bot protection; check Clerk's CSP docs).
14. **Copy honesty:** Pro is "Unlimited words" with "Fair use applies" (Terms explain fair use without a
    number); don't say "No weekly reset". Privacy says Ray's *servers* never store audio or
    transcripts, discloses that dictionary terms are sent to AssemblyAI as recognition hints on
    every transcription and, with cleanup, alongside the transcript and the foreground app's name,
    and says History is kept locally on your PC. No absolute "never stored" claims that ignore
    local History.
15. **Weekly reset display:** always "resets Monday 00:00 UTC" (or a UTC-formatted date), never a
    local weekday. The desktop treats cached usage with `now >= resets_at` as stale (refresh before
    blocking).
16. **Billing success:** after `ray://billing/success`, the desktop polls `/api/me` (1 s, 2 s, 4 s, …, ~45 s
    total) until `plan == "pro"`, showing "Activating Pro…". The site's `/account` refreshes on
    focus/visibility and polls the same way when arriving from `/billing/success`.
    `/api/billing/checkout` records the in-flight checkout in D1 (`pending_checkouts`) and clears it
    from the subscription webhook (15-minute TTL), answering `409 checkout_pending` for a second
    attempt, so a delayed webhook cannot lead to a second subscription or charge. Both clients also
    disable the upgrade CTAs while activation is pending.
17. **Audio cost metering and time-based fair use.** AssemblyAI bills audio time, not
    words, so `usage_weeks` also stores `audio_seconds`, incremented from the bytes streamed
    upstream on every STT request (empty transcripts and upstream failures included).
    Starter enforces its visible word limit plus a hidden weekly audio budget
    (`STARTER_WEEKLY_AUDIO_SECONDS` = 3,600). Pro has **no word cap**; its only hidden cap is
    audio time (`FAIR_USE_WEEKLY_AUDIO_SECONDS` = 25,200 = 7 h). The no-card trial uses
    `TRIAL_WEEKLY_AUDIO_SECONDS` = 10,800 (3 h). Errors keep the existing
    `quota_exceeded` / `fair_use` shapes. Audio numbers are never exposed in `/api/me`.
18. **No-card 14-day trial.** `users.trial_started_at` is set once by the first successful
    desktop token exchange, and only when the account has no subscription row, is not
    free-blocked, and supplied a valid `device_id`. The trial resolves as Pro with
    `trial: { ends_at }` in `/api/me`; paid subscriptions always take precedence. Checkout is
    allowed during a trial but still refused for a paid subscription.
19. **Per-PC free limit.** `devices.device_hash` stores `SHA-256(device_id)`; the fourth and
    later distinct account ever seen on one device is marked `users.free_blocked_at` and
    gets no trial. A free-blocked non-paying account gets `402 device_limit` on STT; a paid
    subscription works normally. `/api/me` exposes `free_blocked`.
