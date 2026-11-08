/**
 * Ray web API Worker entry point.
 *
 * The same Worker serves the static site (Workers Static Assets) but only
 * runs first for `/api/*` and `/v1/*`; see wrangler.jsonc.
 */

import { Hono } from "hono";
import type { AppContext } from "./env";
import {
  applySecurityHeaders,
  corsHeaders,
  securityHeaders,
} from "./http";
import { registerBillingRoutes } from "./routes/billing";
import { registerCleanupRoutes } from "./routes/cleanup";
import { registerDesktopRoutes } from "./routes/desktop";
import { registerMeRoutes } from "./routes/me";
import { registerSttRoutes } from "./routes/stt";
import { registerWebhookRoutes } from "./routes/webhooks";

const app = new Hono<AppContext>();

app.use("*", securityHeaders);
app.use("*", corsHeaders);

app.get("/v1/ping", (c) => c.body(null, 204));

registerMeRoutes(app);
registerDesktopRoutes(app);
registerBillingRoutes(app);
registerWebhookRoutes(app);
registerSttRoutes(app);
registerCleanupRoutes(app);

app.notFound((c) =>
  c.json({ error: "not_found", message: "Not found." }, 404),
);

app.onError((error, c) => {
  // Never include request/response bodies or transcripts in logs.
  console.error(
    "unhandled worker error",
    error instanceof Error ? error.name : "unknown",
  );
  const response = c.json(
    { error: "internal_error", message: "Something went wrong." },
    500,
  );
  applySecurityHeaders(response.headers, c.env.SITE_URL);
  return response;
});

export default app;
