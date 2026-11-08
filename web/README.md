# @ray/web

The Ray web backend and landing site. One Cloudflare Worker serves the static
site (Workers Static Assets) and the API that the desktop app talks to:

- `worker/` — Hono API: Clerk auth, desktop device tokens, Creem billing and
  webhooks, AssemblyAI STT/cleanup proxies, quota enforcement.
- `migrations/` — D1 schema.
- `src/`, `index.html`, `vite.config.ts` — the Vite/React site (owned by the
  site workstream; this package expects `vite build` to output `dist/`).

The desktop app stays at the repository root; this package is part of the
pnpm workspace in `pnpm-workspace.yaml`.

## Requirements

- Node 22+
- pnpm 10+
- A Cloudflare account (`wrangler login`)
- A Clerk application
- A Creem account (test mode is fine to start)
- An AssemblyAI API key

## Quick start (local)

```bash
pnpm install                       # from the repo root
cd web

cp .dev.vars.example .dev.vars     # Worker secrets; never commit this file
cp .env.example .env.local         # Site build-time vars; never commit this file

# Create the local D1 database and apply migrations.
pnpm db:migrate:local

# Terminal 1: API + built site on http://127.0.0.1:8787.
# This creates an empty dist/ placeholder when the site has not been built;
# run `pnpm build` first to serve the real site from the Worker.
pnpm dev:worker

# Terminal 2: Vite dev server for the site (proxies /api and /v1 to 8787;
# see the site's vite.config.ts). Built assets are served by the Worker.
pnpm dev
```

The two-terminal flow above is the normal local setup: Vite serves the site
with hot reload on `http://localhost:5173` and proxies `/api/*` and `/v1/*`
to `http://127.0.0.1:8787`, which is the port `wrangler dev` binds by default
(the same address is in `vite.config.ts`). Sign-in, account and billing work
through that proxy because the browser only ever talks to the Vite origin.
If Vite picks a different port (5173 is busy), update `SITE_URL` in
`.dev.vars` to match, because it drives Clerk's authorized parties.

To exercise the production wiring instead, run `pnpm build` and then
`pnpm dev:worker`: the Worker serves `dist/` with the SPA fallback, so deep
routes such as `/account` and `/desktop/sign-in` work on a hard refresh.

Smoke test the API:

```bash
curl -i http://127.0.0.1:8787/v1/ping        # 204
curl -i http://127.0.0.1:8787/api/me         # 401 JSON
```

For local Clerk sign-in, `.dev.vars.example` sets `SITE_URL` to the Vite
origin (`http://localhost:5173`). The Worker derives Clerk's
`authorizedParties` from `SITE_URL` and also allows the usual
`localhost:5173` / `localhost:8787` loopback spellings when `SITE_URL` is
itself a localhost origin. Keep `SITE_URL` in sync with the site's dev URL.

Creem cannot reach `localhost`. To test webhooks locally, expose the Worker
with a tunnel (for example `cloudflared tunnel --url http://127.0.0.1:8787`)
and point a test-mode webhook at the tunnel URL.

## Environment and secrets

Public configuration lives in `wrangler.jsonc` under `vars`; secrets are set
with `wrangler secret put` (and `.dev.vars` locally). Replace every `REPLACE`
placeholder before deploying.

| Name | Kind | Value |
|---|---|---|
| `SITE_URL` | var | Public origin, e.g. `https://ray.helionhq.com` |
| `CLERK_PUBLISHABLE_KEY` | var | Clerk publishable key (`pk_test_…` / `pk_live_…`) |
| `VITE_CLERK_PUBLISHABLE_KEY` | build-time env | Same key as `CLERK_PUBLISHABLE_KEY`, consumed by Vite when building the site (`web/.env.local`, `web/.env.production`, or CI env). It is public by design — never put a secret in a `VITE_*` variable. |
| `CLERK_SECRET_KEY` | secret | Clerk backend key (`sk_test_…` / `sk_live_…`) |
| `ASSEMBLYAI_API_KEY` | secret | AssemblyAI key used for STT and the LLM gateway |
| `CREEM_API_KEY` | secret | Creem API key (`creem_test_…` / `creem_…`) |
| `CREEM_WEBHOOK_SECRET` | secret | Creem webhook signing secret (`whsec_…`). Missing/blank means every Creem webhook is rejected with 401. |
| `CLERK_WEBHOOK_SECRET` | secret (required) | Svix signing secret for Clerk webhooks. Required for account deletion: when unset, `POST /api/webhooks/clerk` answers 503 and deleted accounts keep their PII, device access and Creem subscription. |
| `CREEM_API_BASE` | var | `https://test-api.creem.io` or `https://api.creem.io` |
| `CREEM_PRODUCT_PRO_MONTHLY` | var | Creem product id for Pro Monthly ($9/mo) |
| `CREEM_PRODUCT_PRO_ANNUAL` | var | Creem product id for Pro Annual ($84/yr) |
| `STARTER_WEEKLY_WORDS` | var | Starter weekly allowance, default `1000` |
| `STARTER_WEEKLY_AUDIO_SECONDS` | var | Hidden Starter weekly audio budget, default `3600` (60 minutes). Audio seconds are metered from bytes streamed to AssemblyAI. |
| `FAIR_USE_WEEKLY_AUDIO_SECONDS` | var | Hidden Pro weekly audio fair-use cap, default `25200` (7 hours) |
| `TRIAL_WEEKLY_AUDIO_SECONDS` | var | Hidden 14-day-trial weekly audio budget, default `10800` (3 hours) |
| `CLEANUP_MODELS` | var | Comma-separated model allowlist, default `gemma-4-31b` |

Set the five required secrets in production:

```bash
cd web
wrangler secret put CLERK_SECRET_KEY
wrangler secret put ASSEMBLYAI_API_KEY
wrangler secret put CREEM_API_KEY
wrangler secret put CREEM_WEBHOOK_SECRET
# Required: enables the Clerk user.deleted webhook (account deletion).
wrangler secret put CLERK_WEBHOOK_SECRET
```

`wrangler dev` reads `.dev.vars`; keep that file out of git (it is ignored).

## Clerk setup

1. Create an application at https://dashboard.clerk.com.
2. Enable **Email** (code or password, whichever Clerk defaults to) and
   **Google** as sign-in methods.
3. Copy the publishable key into `wrangler.jsonc` (`CLERK_PUBLISHABLE_KEY`) and
   the secret key into `wrangler secret put CLERK_SECRET_KEY`.
4. Add `SITE_URL` (and, for local development, `http://localhost:5173`) to the
   Clerk application's allowed origins / authorized parties.
5. The site reads its publishable key at build time from
   `VITE_CLERK_PUBLISHABLE_KEY`; it must be the same Clerk application as the
   Worker's `CLERK_PUBLISHABLE_KEY`. For local development:

   ```bash
   cp .env.example .env.local
   # edit .env.local:
   # VITE_CLERK_PUBLISHABLE_KEY=pk_test_…
   ```

   For production builds set the same variable in CI or in
   `web/.env.production` (both are ignored by git). `pnpm deploy` builds
   first, so a deploy without the variable produces a site that renders the
   "auth not configured" notice; the API keeps working. Without the variable
   at all, the public marketing pages still build and work.

The Worker verifies the Clerk session JWT with `@clerk/backend` `verifyToken`,
passing `authorizedParties` derived from `SITE_URL` (an empty/invalid
`SITE_URL` is a 500 config error, never an open allowlist) and, when the
publishable key is parseable, the `issuer` derived from its Frontend API
host. It fetches the user's email/name from Clerk the first time it sees them.

### Clerk `user.deleted` webhook (required for account deletion)

Create a Clerk webhook pointing at `{SITE_URL}/api/webhooks/clerk`, subscribe
to `user.deleted`, and store the Svix signing secret as
`CLERK_WEBHOOK_SECRET`. Account deletion depends on this webhook, so treat it
and the secret as required launch steps. The endpoint verifies `svix-id`,
`svix-timestamp` (five-minute tolerance) and `svix-signature` over the raw
body. On `user.deleted` it cancels any still-renewing Creem subscriptions
(best effort, `POST /v1/subscriptions/{id}/cancel` with `mode: "immediate"`),
revokes every device token, deletes outstanding desktop sign-in codes, and
soft-deletes the user so device tokens and Clerk sessions stop working
immediately. A Creem cancellation failure is logged (without user ids) and
never fails the webhook, so deletion always proceeds. Without the secret the
endpoint answers 503 and deletion does not run, so the privacy policy's
deletion promise would not be honored. Other Clerk event types are
acknowledged and ignored.

## Creem setup

1. Create two recurring products in the Creem dashboard:
   - **Pro Monthly** — $9/month
   - **Pro Annual** — $84/year ($7/month billed annually)
2. Copy both product ids into `CREEM_PRODUCT_PRO_MONTHLY` and
   `CREEM_PRODUCT_PRO_ANNUAL`.
3. Set `CREEM_API_BASE` to `https://test-api.creem.io` for test mode or
   `https://api.creem.io` for live. Create the API key in the same mode and
   store it as `CREEM_API_KEY`.
4. Add a webhook endpoint pointing at `{SITE_URL}/api/webhooks/creem` and
   subscribe to at least:
   `checkout.completed`, `subscription.active`, `subscription.paid`,
   `subscription.trialing`, `subscription.canceled`,
   `subscription.scheduled_cancel`, `subscription.past_due`,
   `subscription.unpaid`, `subscription.paused`, `subscription.update`,
   `subscription.expired`, `refund.created`, `dispute.created`. Store the
   signing secret as `CREEM_WEBHOOK_SECRET`.
5. Checkout returns to `{SITE_URL}/billing/success`, which the site can bounce
   to `ray://billing/success` so the desktop refreshes `/api/me`.

Billing integrity rules (enforced server-side):

- Only the two configured product ids (`CREEM_PRODUCT_PRO_MONTHLY` and
  `CREEM_PRODUCT_PRO_ANNUAL`) ever grant Pro. Any other product's
  subscription is stored but is not entitled; read-time resolution applies
  the same product allowlist as a second line of defence.
- `refund.created` and `dispute.created` set the subscription to `revoked`
  immediately. `revoked` (and `expired`/`unpaid`) win equal-`updated_at`
  ordering ties, so a late `active` event with the same timestamp cannot
  restore Pro.
- Users are mapped by `metadata.user_id` first, then an existing
  `creem_customer_id`. Email is never used for account mapping.
  `users.creem_customer_id` is uniquely indexed.
- The webhook idempotency marker (`webhook_events`) is written in the same D1
  batch as, and after, the state change. If the batch fails, everything rolls
  back and Creem's retry applies normally.
- A missing `CREEM_WEBHOOK_SECRET` rejects every webhook with 401.

## D1

Create the database once per Cloudflare account:

```bash
cd web
wrangler d1 create ray
```

Copy the returned `database_id` into `wrangler.jsonc` (`d1_databases`, binding
`DB`) and apply migrations:

```bash
pnpm db:migrate:local      # local state used by wrangler dev
pnpm db:migrate:remote     # the real database
```

Schema lives in `migrations/`. Add new migrations as
`0002_description.sql`, etc. `0002_review_round.sql` adds
`cleanup_grants`, `stt_leases`, `stt_failures`, `users.deleted_at` and the
unique `creem_customer_id` index; `0003_pending_checkout.sql` adds
`pending_checkouts`; `0004_audio_metering.sql` adds
`usage_weeks.audio_seconds`; `0001_init.sql` is never edited.

## Build and deploy

```bash
cd web
pnpm build                 # vite build -> dist/
pnpm deploy                # vite build + wrangler deploy
```

`pnpm deploy` is the only deploy command: it builds the site first (so the
`VITE_CLERK_PUBLISHABLE_KEY` must be in the environment or `.env.production`
at that moment) and then uploads the Worker and `dist/` together.

`wrangler.jsonc` configures one Worker:

- `main: worker/index.ts`
- static assets from `./dist`
- `not_found_handling: "single-page-application"`, so client routes such as
  `/account`, `/desktop/sign-in`, `/billing/success`, `/privacy` and `/terms`
  return the SPA HTML (200) on a hard refresh instead of a 404
- `run_worker_first: ["/api/*", "/v1/*"]`, so the site is served directly from
  assets and only API routes invoke the Worker
- the `DB` D1 binding

Add the custom domain in the Cloudflare dashboard (Workers → ray-web →
Settings → Domains & Routes) or via a `routes` entry in `wrangler.jsonc`, then
set `SITE_URL` to that origin and update Clerk/Creem accordingly.

Deployment checklist:

- [ ] `wrangler.jsonc` placeholders replaced (`SITE_URL`, Clerk publishable
      key, Creem product ids)
- [ ] `VITE_CLERK_PUBLISHABLE_KEY` set for the build and equal to the Worker's
      `CLERK_PUBLISHABLE_KEY`
- [ ] all five required secrets set with `wrangler secret put`, including
      `CLERK_WEBHOOK_SECRET`
- [ ] `wrangler d1 create` + `pnpm db:migrate:remote` (includes `0002`-`0004`)
- [ ] Clerk authorized parties include the production origin
- [ ] Creem webhook points at `{SITE_URL}/api/webhooks/creem`, subscribes to
      refunds/disputes, and the signing secret matches
- [ ] Clerk webhook points at `{SITE_URL}/api/webhooks/clerk`, subscribes to
      `user.deleted`, and its signing secret matches — required for account
      deletion
- [ ] `pnpm typecheck` and `pnpm test` pass
- [ ] `/v1/ping` returns 204 and `/api/me` returns 401 anonymously

## Changing the domain

`ray.helionhq.com` is a **placeholder** until the real domain is chosen. A
domain change touches more than `SITE_URL`; work through this list in one
commit so the Worker, the site, the CSP and the desktop stay in sync.

1. **Worker origin** — `web/wrangler.jsonc`, `vars.SITE_URL`. This drives
   Clerk's `authorizedParties`, CORS, the Creem `success_url` and the
   security headers.
2. **Cloudflare** — add the custom domain to the Worker (Workers → `ray-web` →
   Settings → Domains & Routes, or a `routes` entry), and point the DNS record
   at it.
3. **Site constants** — `web/src/content.ts`:
   - `SITE_ORIGIN` (canonical, Open Graph and Twitter URLs);
   - `CONTACT_EMAIL` (`privacy@helionhq.com`) if the mail domain changes;
   - `DOWNLOAD_URL` / `REPOSITORY_URL` only if the GitHub organisation changes
     (these are not the site domain).
4. **Static HTML defaults** — `web/index.html`: the `rel="canonical"` link and
   the `og:url`, `og:image` and `twitter:image` URLs (what a crawler that does
   not run JavaScript sees; `web/src/lib/head.ts` rewrites them per route from
   `SITE_ORIGIN`).
5. **CSP / security headers** — `web/public/_headers`. The Content-Security
   Policy names the placeholder Clerk Frontend API (FAPI) hosts
   `clerk.helionhq.com` and `*.helionhq.com` in both `script-src` and
   `connect-src`. Replace them with the production Clerk FAPI host
   (`https://clerk.<real-domain>` or the custom FAPI domain shown in the Clerk
   dashboard) and the matching wildcard. Keep `https://*.clerk.accounts.dev`
   for development instances, and `https://challenges.cloudflare.com` /
   `https://*.protect.clerk.com` for Clerk bot protection. If sign-in shows a
   CSP violation in the browser console, the FAPI host is the first thing to
   check.
6. **Desktop defaults** — `src-tauri/config/pipeline.json`
   (`api.base_url` and `api.site_url`) and `src-tauri/src/config.rs`
   (`DEFAULT_API_BASE`, the fallback for an old override with no `api`
   object). Release builds otherwise keep pointing at the placeholder.
7. **Clerk dashboard** — add the new origin to the application's allowed
   origins / authorized parties. The publishable key does not change; it
   already encodes the Clerk FAPI domain.
8. **Creem dashboard** — point the webhook at
   `https://<new-origin>/api/webhooks/creem` and let checkout return to
   `https://<new-origin>/billing/success` (the Worker builds this from
   `SITE_URL`).
9. **Local dev** — update `SITE_URL` in `web/.dev.vars` only if you are
   testing against that host locally (the example uses
   `http://localhost:5173`).
10. **Docs and tests (cosmetic)** — the placeholder also appears as an example
    in the root `README.md`, this file, `docs/commercial-contract.md`, and in
    test fixtures (`web/test/auth.test.ts`, `src-tauri/src/api.rs`,
    `src-tauri/src/auth.rs`, `src-tauri/src/config.rs`). Update them for
    consistency; they do not affect production behaviour.

Verify after the change: `pnpm typecheck && pnpm test`, then a `wrangler dev`
smoke test (`/` 200 with the new CSP host, `/api/me` 401), and a desktop
sign-in (the browser hand-off checks `SITE_URL`).

## API summary

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/ping` | none | 204 pre-warm |
| GET | `/api/me` | either | user, plan, usage, `billing_issue` |
| POST | `/api/desktop/authorize` | Clerk JWT | issue one-time desktop code |
| POST | `/api/desktop/token` | code + verifier | issue device token |
| POST | `/api/desktop/signout` | device | revoke this device |
| POST | `/api/devices/revoke-all` | Clerk JWT | revoke every device for the user |
| POST | `/api/billing/checkout` | either | Creem checkout URL |
| POST | `/api/billing/portal` | either | Creem customer portal URL |
| POST | `/api/webhooks/creem` | Creem signature | subscription/refund/dispute lifecycle |
| POST | `/api/webhooks/clerk` | Svix signature | `user.deleted` (required for account deletion) |
| POST | `/v1/stt/sync-live` | device | streamed AssemblyAI Sync live proxy (12 MB cap) |
| POST | `/v1/stt/sync` | device | AssemblyAI Sync batch proxy (12 MB cap) |
| POST | `/v1/stt/batch` | device | v2 upload/create/poll fallback (12 MB cap) |
| POST | `/v1/cleanup/chat/completions` | device | AssemblyAI LLM gateway proxy (grant-gated) |

Plans: **Starter** (1,000 words/week, resets Monday 00:00 UTC), **Pro**
(unlimited, with a hidden weekly audio fair-use cap), and a **14-day no-card Pro
trial** that starts on the first desktop sign-in. Quota failures are
`402 quota_exceeded` for Starter, `429 fair_use` for Pro/trial audio, and
`402 device_limit` for a free account over the per-PC limit.

### API fields and error codes other clients rely on

- `GET /api/me` always returns `user.email` as a string (`""` when unknown),
  and `billing_issue: null | "past_due" | "unpaid" | "paused"`. When it is
  non-null, show "Payment issue: update your card" and the portal instead of
  upgrade buttons.
- `GET /api/me` also returns `trial: null | { ends_at }` and
  `free_blocked: boolean`. While `trial` is non-null the plan is `"pro"` but
  `interval`/`status` stay null (there is no subscription); show "Pro trial ·
  N days left". `free_blocked` means the PC is over the free-account limit.
- `POST /api/billing/checkout` returns `409 { error: "billing_issue" }` while
  a payment issue is outstanding, and `409 { error: "already_subscribed" }`
  only for a paid Pro account (checkout is allowed during the trial).
- `402 { error: "device_limit" }` is returned on STT for a free-blocked
  account that has no paid subscription. It must stop dictation without a
  batch fallback, exactly like `quota_exceeded`.
- `POST /api/devices/revoke-all` returns `{ ok: true, revoked: <count> }`.
- `POST /api/webhooks/clerk` returns `503 { error: "not_configured" }` when
  `CLERK_WEBHOOK_SECRET` is unset.
- Upstream STT/cleanup failures never leak the upstream status: upstream
  401/402/403/5xx become `502 { error: "upstream_error" }` and upstream 429
  becomes `503 { error: "upstream_busy" }`. The desktop must classify Ray
  errors by the JSON `error` code, not the HTTP status.
- `429 { error: "too_many_requests" }` comes from the STT concurrency lease,
  the weekly failed-transcription budget, or a rate-limit binding. It is not
  a quota error and follows the normal batch-fallback path.

## Abuse and integrity controls

- **Cleanup grants (decision 1).** `/v1/cleanup/chat/completions` no longer
  checks the weekly quota. Every STT response that counted words upserts
  `cleanup_grants`: words accumulate inside a 15-minute window, 6 calls are
  added per transcription up to 30, and an expired grant restarts. Cleanup
  atomically decrements `calls_left` and rejects with
  `403 { error: "no_cleanup_grant" }` when there is no unexpired grant or the
  `<transcript>…</transcript>` content exceeds the granted words + 25. A
  message without transcript tags is counted in full so the endpoint cannot be
  repurposed. The desktop treats this like any cleanup failure (paste the raw
  transcript).
- **Cleanup body whitelist (decision 2).** Only `model`, `messages`,
  `temperature`, `max_tokens` (clamped to 4000) and `stream: false` are
  forwarded. `n`, `max_completion_tokens`, tools and every other field are
  dropped. At most one system + one user message, system ≤ 24 KB, user ≤ 40 KB,
  whole body ≤ 64 KB. The desktop keeps the rendered Structured prompt under
  this cap by truncating the dictionary to the first terms that fit (200 terms
  of 80 characters would otherwise exceed it); normal dictionaries are sent
  unchanged.
- **STT concurrency lease (decision 3).** At most 2 in-flight STT requests per
  user, tracked in D1 `stt_leases` with a 6-minute expiry and released in a
  `finally`. Over the cap: `429 too_many_requests`.
- **Failed-transcription budget (M2).** A transcription that fails consumes
  no words, so failures are counted per user per ISO week in `stt_failures`.
  A successful response that produced zero words (silence or noise) counts the
  same way: it still costs an upstream transcription but adds nothing to the
  word quota. After 200 such attempts in one week, STT answers
  `429 too_many_requests` (with `resets_at`) until the next Monday.
- **STT input cap (decision 6).** Every STT route — `/v1/stt/sync-live`,
  `/v1/stt/sync` and `/v1/stt/batch` — rejects a declared `Content-Length`
  over 12 MB and enforces the same cap chunk by chunk while streaming the
  audio to AssemblyAI. Nothing calls `arrayBuffer()` on an unbounded body.
- **Time-based fair use.** Pro has no weekly word cap. Its only hidden cap is
  audio time (`FAIR_USE_WEEKLY_AUDIO_SECONDS` = 7 h/week); the 14-day trial
  uses `TRIAL_WEEKLY_AUDIO_SECONDS` = 3 h/week. Starter keeps its visible
  1,000-word limit plus the hidden 60-minute audio budget. Over an audio cap
  the STT proxy answers `429 fair_use` (Pro/trial) or `402 quota_exceeded`
  (Starter). None of the hidden numbers appear in `/api/me` or the site.
- **No-card trial.** `users.trial_started_at` is set once by the first
  successful `POST /api/desktop/token`, and only when the account has no
  subscription row, is not free-blocked, and sent a valid `device_id`. It
  never starts on site-only sign-up. During the trial the account resolves as
  Pro with `trial: { ends_at }`; a paid subscription wins.
- **Per-PC free limit.** The desktop sends `device_id =
  base64url(SHA-256("ray-device-v1:" + MachineGuid))`; the raw GUID never
  leaves the PC. The Worker stores `SHA-256(device_id)` in
  `devices.device_hash` and counts distinct users that ever used that hash
  (revoked rows included). A fourth or later distinct account is marked
  `users.free_blocked_at`: sign-in still succeeds, but it gets no trial and,
  without a paid plan, every STT request answers `402 device_limit`.
- **Rate limiting (M6).** The Worker uses Workers Rate Limiting bindings
  (`ratelimits` in `wrangler.jsonc`): per user for
  `/api/desktop/authorize`, `/api/billing/*`, `/api/devices/revoke-all` and
  every `/v1/stt/*` route, per IP for `/api/desktop/token` and both webhook
  endpoints. Counts are per Cloudflare location and eventually consistent. If
  a binding is absent at runtime (for example an older local runtime), the
  Worker logs one warning and continues without rate limiting.

Live rollover: overlapping segments from two simultaneous dictations may be
counted twice. This is accepted; the quota is a cost guard, not an exact
billing meter.

## Privacy

Audio and transcripts pass through the Worker in memory to AssemblyAI. They
are never written to D1, logs, or analytics. D1 stores only users, devices,
one-time auth codes, subscriptions, webhook ids, weekly word counts and
audio-second counters, cleanup grant counters, STT leases, weekly failure
counts, and — for the per-PC free limit — a one-way hashed device identifier
(`SHA-256` of the already-hashed id the desktop sends). The raw hardware id is
never received. Do not add logging of request/response bodies, audio or
transcripts anywhere in `worker/`.

## Tests

```bash
pnpm typecheck
pnpm test
```

`vitest.config.ts` uses `@cloudflare/vitest-plugin`, so every test runs inside
the Workers runtime with a real local D1. `test/setup.ts` applies
`migrations/` before the suite. Unit tests cover week math, word counting
(including CJK and the AssemblyAI `words` array), cleanup grants and body
whitelisting, rate-limit helpers, Svix signatures, Clerk config fail-closed
behaviour, PKCE, Creem signatures, plan resolution/product gating, quotas and
webhook ordering. Integration tests exercise the desktop hand-off (including
single-use codes), the usage UPSERT, cleanup grant consumption and transcript
binding, lease caps and release-on-error, the weekly failure budget, the 12 MB
batch cap, upstream 401/429 → 502/503 mapping, webhook idempotency after apply
(with a simulated marker failure and retry), refund/dispute revocation,
product-id gating, no email mapping, missing-secret fail-closed behaviour,
terminal-status ties, `/api/me` email/`billing_issue`, checkout 409, revoke-all
storage, the Clerk `user.deleted` webhook, and rate-limit denial.
