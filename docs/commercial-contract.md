# Ray commercial launch: shared contract

This is the single source of truth that every workstream builds against. If you need to
deviate, keep the deviation minimal and record it in your final report.

## Product decisions (fixed)

- Plans: **Starter** (free) and **Pro** (paid). Use exactly these names.
  - Starter: **1,000 words per week**. Week resets **every Monday 00:00 UTC**.
  - Pro: **unlimited words**, marketed as unlimited. A hidden weekly **fair-use cap**
    (default 100,000 words/week, env `FAIR_USE_WEEKLY_WORDS`) protects costs. Never
    advertise the number; show a polite "fair-use limit reached, resets Monday" message only
    when it is actually hit.
  - Pro price: **$8/month billed monthly**, or **$6/month billed annually ($72/year)**.
- Auth: **Clerk**, with **email** (code or password, whichever Clerk defaults to) and **Google**.
- Payments: **Creem** (https://docs.creem.io). Two Creem products: Pro Monthly, Pro Annual.
- Backend: **Cloudflare Workers + D1**, deployed together with the public landing page as
  **one Worker** (Workers Static Assets for the site, `/api/*` and `/v1/*` handled in code).
- Privacy: audio and transcripts **pass through** the Worker in memory to AssemblyAI and are
  **never stored or logged**. D1 holds only users, device sessions, subscriptions, and
  weekly **word counts**. Do not `console.log` request or response bodies anywhere.
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
| `FAIR_USE_WEEKLY_WORDS` | var | default `100000` |
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
   `POST /api/desktop/token` with `{ code, verifier }`. The Worker checks
   `base64url(sha256(verifier)) == challenge`, consumes the code, and returns
   `{ token, user: { id, email, name } }`. `token` is an opaque device token
   (`ray_` + 32 random bytes base64url), stored **hashed (SHA-256)** in D1 `devices`, with no
   expiry (revocable).
5. The app stores the token in Windows Credential Manager (service `ray`, account `session`).
6. Every desktop request sends `Authorization: Bearer <device token>`.
7. `POST /api/desktop/signout` (device token auth) revokes it. The app deletes it locally too.

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
| POST | `/api/billing/checkout` | either | body `{ interval: "monthly" \| "annual" }` → `{ url }` (Creem checkout) |
| POST | `/api/billing/portal` | either | → `{ url }` (Creem customer portal) |
| POST | `/api/webhooks/creem` | Creem signature | subscription lifecycle |
| POST | `/v1/stt/sync-live` | device | streaming proxy for AssemblyAI Sync live |
| POST | `/v1/stt/sync` | device | proxy for AssemblyAI Sync batch |
| POST | `/v1/stt/batch` | device | server-side v2 fallback: body is a WAV; Worker uploads, creates, polls; returns `{ text }` |
| POST | `/v1/cleanup/chat/completions` | device | OpenAI-compatible proxy to the AssemblyAI LLM gateway |

`GET /api/me` response:

```json
{
  "user": { "id": "user_…", "email": "a@b.com", "name": "Arham" },
  "plan": "starter",                 // "starter" | "pro"
  "interval": null,                  // null | "monthly" | "annual"
  "status": null,                    // null | "active" | "trialing" | "past_due" | "canceled" ...
  "cancel_at_period_end": false,
  "current_period_end": null,        // ISO string or null
  "usage": {
    "words_used": 412,
    "words_limit": 1000,             // null for Pro (do NOT expose the fair-use cap)
    "week_start": "2026-11-02T00:00:00Z",
    "resets_at": "2026-11-09T00:00:00Z"
  }
}
```

A user is **Pro** when they have a subscription with status `active` or `trialing`, or one
that is `canceled`/`scheduled_cancel` but whose `current_period_end` is still in the future.
Otherwise they're Starter.

### STT proxy details

- `/v1/stt/sync-live`: the desktop sends exactly what it used to send to
  `https://sync.assemblyai.com/v1/transcribe/live` (streamed multipart body, `X-AAI-Model`
  header, `content-type` with boundary). The Worker checks auth + quota **before** reading
  the body, then forwards the streamed body (`request.body`) upstream with
  `authorization: <ASSEMBLYAI_API_KEY>`, forwarding only `content-type` and `X-AAI-Model`.
  It reads the upstream JSON, counts words in `text`, adds them to this week's usage, and
  returns the upstream status + body unchanged.
- `/v1/stt/sync`: same, for `https://sync.assemblyai.com/v1/transcribe` (non-streamed body).
- `/v1/stt/batch`: request body is `audio/wav`, optional header `X-Ray-Keyterms` with a
  JSON array of strings (base64url-encoded JSON, since headers can't hold arbitrary
  Unicode), plus optional `X-Ray-Speech-Models` (comma-separated). The Worker does
  upload → create transcript → poll (700 ms) up to 45 s, counts words, and returns
  `{ "text": "…" }`.
- Word count = number of whitespace-separated tokens in the final transcript text.
- Quota is checked **before** the upstream call. Going over mid-dictation is allowed (the
  dictation that crosses the line completes and is counted).

Quota errors (no fallback should be attempted by the desktop for these):
- `402 { "error": "quota_exceeded", "message": "…", "plan": "starter", "words_used", "words_limit", "resets_at" }`
- `429 { "error": "fair_use", "message": "…", "resets_at" }` (Pro over the hidden cap)
- `401 { "error": "unauthorized" }` → desktop treats as signed out.

### Cleanup proxy details

`/v1/cleanup/chat/completions` forwards to
`https://llm-gateway.assemblyai.com/v1/chat/completions` with
`authorization: Bearer <ASSEMBLYAI_API_KEY>`. Abuse guards: `model` must be in
`CLEANUP_MODELS`; `max_tokens` is clamped to ≤ 4000; the body must be ≤ 64 KB; `stream`
is forced false; the user must be within quota (same 402/429). Cleanup words are **not**
counted (STT already counted them).

## D1 schema (minimum)

- `users(id TEXT PK /* clerk user id */, email TEXT, name TEXT, creem_customer_id TEXT, created_at INTEGER)`
- `devices(id TEXT PK, user_id TEXT, token_hash TEXT UNIQUE, created_at INTEGER, last_used_at INTEGER, revoked_at INTEGER)`
- `auth_codes(code_hash TEXT PK, user_id TEXT, challenge TEXT, state TEXT, expires_at INTEGER, used_at INTEGER)`
- `subscriptions(id TEXT PK /* creem subscription id */, user_id TEXT, product_id TEXT, interval TEXT, status TEXT, current_period_end INTEGER, cancel_at_period_end INTEGER, updated_at INTEGER)`
- `usage_weeks(user_id TEXT, week_start INTEGER /* unix seconds, Monday 00:00 UTC */, words INTEGER, PRIMARY KEY(user_id, week_start))`
- `webhook_events(id TEXT PK, received_at INTEGER)` for idempotency

## Desktop UI expectations

- **Signed out:** the main window shows a clean sign-in screen ("Sign in to start
  dictating", with a button that opens the browser, and a "Waiting for your browser…" state
  with a cancel option). Pressing the dictation shortcut while signed out shows a short bar
  message ("Sign in to Ray to dictate") and opens the main window.
- **Account** (new nav item or a top section of Settings): email, plan badge
  (Starter/Pro), a weekly usage meter for Starter ("412 of 1,000 words this week · resets
  Monday"), upgrade buttons ("Upgrade to Pro: $8/mo" and "$6/mo billed yearly", which open
  checkout in the browser), "Manage billing" for Pro (portal), and "Sign out". Refresh `/api/me`
  on window focus, after each dictation, and when a `ray://billing/success` deep link
  arrives (Creem success_url can point to `{SITE_URL}/billing/success`, which bounces to
  `ray://billing/success`).
- **Limit reached:** at recording start, if the cached `/api/me` says Starter is at or
  over the limit, don't record. The bar shows "Weekly limit reached" (or similar, short) and
  the main window opens to Account. A 402/429 from the proxy also ends the session with that
  message and **does not** fall back to batch.
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
