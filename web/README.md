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
| `CREEM_WEBHOOK_SECRET` | secret | Creem webhook signing secret (`whsec_…`) |
| `CREEM_API_BASE` | var | `https://test-api.creem.io` or `https://api.creem.io` |
| `CREEM_PRODUCT_PRO_MONTHLY` | var | Creem product id for Pro Monthly ($8/mo) |
| `CREEM_PRODUCT_PRO_ANNUAL` | var | Creem product id for Pro Annual ($72/yr) |
| `STARTER_WEEKLY_WORDS` | var | Starter weekly allowance, default `1000` |
| `FAIR_USE_WEEKLY_WORDS` | var | Hidden Pro fair-use cap, default `100000` |
| `CLEANUP_MODELS` | var | Comma-separated model allowlist, default `gemma-4-31b` |

Set the four secrets in production:

```bash
cd web
wrangler secret put CLERK_SECRET_KEY
wrangler secret put ASSEMBLYAI_API_KEY
wrangler secret put CREEM_API_KEY
wrangler secret put CREEM_WEBHOOK_SECRET
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
passing `authorizedParties` derived from `SITE_URL`, and fetches the user's
email/name from Clerk the first time it sees them.

## Creem setup

1. Create two recurring products in the Creem dashboard:
   - **Pro Monthly** — $8/month
   - **Pro Annual** — $72/year ($6/month billed annually)
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
   `subscription.update`, `subscription.expired`. Store the signing secret as
   `CREEM_WEBHOOK_SECRET`.
5. Checkout returns to `{SITE_URL}/billing/success`, which the site can bounce
   to `ray://billing/success` so the desktop refreshes `/api/me`.

Users are mapped to Creem via `metadata.user_id` set at checkout. The Worker
stores `creem_customer_id` from webhook events and verifies every webhook's
`creem-signature` (HMAC-SHA256 over the raw body) in constant time. Events are
idempotent (`webhook_events`) and older events cannot overwrite newer
subscription state.

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
`0002_description.sql`, etc.

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
- [ ] all four secrets set with `wrangler secret put`
- [ ] `wrangler d1 create` + `pnpm db:migrate:remote`
- [ ] Clerk authorized parties include the production origin
- [ ] Creem webhook points at `{SITE_URL}/api/webhooks/creem` and the signing
      secret matches
- [ ] `pnpm typecheck` and `pnpm test` pass
- [ ] `/v1/ping` returns 204 and `/api/me` returns 401 anonymously

## API summary

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/ping` | none | 204 pre-warm |
| GET | `/api/me` | either | user, plan, usage |
| POST | `/api/desktop/authorize` | Clerk JWT | issue one-time desktop code |
| POST | `/api/desktop/token` | code + verifier | issue device token |
| POST | `/api/desktop/signout` | device | revoke this device |
| POST | `/api/billing/checkout` | either | Creem checkout URL |
| POST | `/api/billing/portal` | either | Creem customer portal URL |
| POST | `/api/webhooks/creem` | Creem signature | subscription lifecycle |
| POST | `/v1/stt/sync-live` | device | streamed AssemblyAI Sync live proxy |
| POST | `/v1/stt/sync` | device | AssemblyAI Sync batch proxy |
| POST | `/v1/stt/batch` | device | v2 upload/create/poll fallback |
| POST | `/v1/cleanup/chat/completions` | device | AssemblyAI LLM gateway proxy |

Plans: **Starter** (1,000 words/week, resets Monday 00:00 UTC) and **Pro**
(unlimited, with a hidden weekly fair-use cap). Quota failures are
`402 quota_exceeded` for Starter and `429 fair_use` for Pro.

## Privacy

Audio and transcripts pass through the Worker in memory to AssemblyAI. They
are never written to D1, logs, or analytics. D1 stores only users, devices,
one-time auth codes, subscriptions, webhook ids, and weekly word counts. Do not
add logging of request/response bodies anywhere in `worker/`.

## Tests

```bash
pnpm typecheck
pnpm test
```

`vitest.config.ts` uses `@cloudflare/vitest-plugin`, so every test runs inside
the Workers runtime with a real local D1. `test/setup.ts` applies
`migrations/` before the suite. Unit tests cover week math, word counting,
PKCE, Creem signatures, plan resolution, quotas and webhook ordering.
Integration tests exercise the desktop hand-off (including single-use codes),
the usage UPSERT, webhook idempotency/out-of-order handling, and the 402/429
shapes through `SELF.fetch`.
