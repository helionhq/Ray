/**
 * Workers Rate Limiting binding helpers.
 *
 * The bindings are optional at runtime: local/test runtimes that do not
 * provide them degrade to "not rate limited" with a single warning, so a
 * missing binding never breaks auth or billing.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { AppContext, Env, RateLimitBinding } from "../env";

export type RateLimitBindingName =
  | "RATE_LIMIT_AUTHORIZE"
  | "RATE_LIMIT_BILLING"
  | "RATE_LIMIT_REVOKE_ALL"
  | "RATE_LIMIT_DESKTOP_TOKEN"
  | "RATE_LIMIT_WEBHOOKS"
  | "RATE_LIMIT_STT";

const warned = new Set<string>();

function warnOnce(name: string, reason: string): void {
  if (warned.has(name)) return;
  warned.add(name);
  console.warn(
    `rate limiting binding ${name} is ${reason}; requests are not rate limited`,
  );
}

/** Returns true when the request is allowed. Fails open on binding errors. */
export async function allowRequest(
  binding: RateLimitBinding | undefined,
  name: string,
  key: string,
): Promise<boolean> {
  if (!binding) {
    warnOnce(name, "not configured");
    return true;
  }
  try {
    const outcome = await binding.limit({ key });
    return outcome.success;
  } catch {
    warnOnce(name, "unavailable");
    return true;
  }
}

export function clientIp(
  c: Context<AppContext>,
): string {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

function tooManyRequests(c: Context<AppContext>): Response {
  return c.json(
    {
      error: "too_many_requests",
      message: "Too many requests. Try again in a moment.",
    },
    429,
  );
}

/** Per-user limit; must run after authentication. */
export function rateLimitUser(
  name: RateLimitBindingName,
): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const user = c.get("user");
    if (!(await allowRequest(c.env[name], name, `user:${user.id}`))) {
      return tooManyRequests(c);
    }
    await next();
  };
}

/** Per-IP limit for unauthenticated endpoints (token exchange, webhooks). */
export function rateLimitIp(
  name: RateLimitBindingName,
): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    if (!(await allowRequest(c.env[name], name, `ip:${clientIp(c)}`))) {
      return tooManyRequests(c);
    }
    await next();
  };
}
