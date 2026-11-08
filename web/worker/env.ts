/** Worker bindings and the objects stored in Hono's request context. */

/**
 * Minimal shape of the Workers Rate Limiting binding. Keeping our own
 * interface (instead of relying on a lib-specific global type) makes the
 * binding injectable and mockable in tests.
 */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;

  // Public vars (wrangler.jsonc).
  SITE_URL: string;
  CLERK_PUBLISHABLE_KEY: string;
  CREEM_API_BASE: string;
  CREEM_PRODUCT_PRO_MONTHLY: string;
  CREEM_PRODUCT_PRO_ANNUAL: string;
  STARTER_WEEKLY_WORDS: string;
  FAIR_USE_WEEKLY_WORDS: string;
  CLEANUP_MODELS: string;

  // Secrets (wrangler secret put / .dev.vars).
  CLERK_SECRET_KEY: string;
  ASSEMBLYAI_API_KEY: string;
  CREEM_API_KEY: string;
  /**
   * Optional on purpose: a missing secret fails webhook verification closed
   * (401) rather than crashing with an unhandled error.
   */
  CREEM_WEBHOOK_SECRET?: string;
  /**
   * Optional: Clerk's `user.deleted` webhook is disabled (503) when unset.
   */
  CLERK_WEBHOOK_SECRET?: string;

  // Workers Rate Limiting bindings. Optional so a missing binding degrades to
  // "not rate limited" with a one-time warning instead of failing every
  // request (the vitest/miniflare runtime may not provide them).
  RATE_LIMIT_AUTHORIZE?: RateLimitBinding;
  RATE_LIMIT_BILLING?: RateLimitBinding;
  RATE_LIMIT_REVOKE_ALL?: RateLimitBinding;
  RATE_LIMIT_DESKTOP_TOKEN?: RateLimitBinding;
  RATE_LIMIT_WEBHOOKS?: RateLimitBinding;
  RATE_LIMIT_STT?: RateLimitBinding;
}

export interface UserRow {
  id: string;
  email: string | null;
  name: string | null;
  creem_customer_id: string | null;
  created_at: number;
}

export interface SubscriptionRow {
  id: string;
  user_id: string;
  product_id: string | null;
  interval: string | null;
  status: string;
  current_period_end: number | null;
  cancel_at_period_end: number;
  /** Unix milliseconds; used to reject out-of-order webhooks. */
  updated_at: number;
}

export interface DeviceRow {
  id: string;
  user_id: string;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface AuthCodeRow {
  code_hash: string;
  user_id: string;
  challenge: string;
  state: string;
  expires_at: number;
  used_at: number | null;
}

export type AuthKind = "clerk" | "device";

export interface AppVariables {
  user: UserRow;
  authKind: AuthKind;
  deviceId: string | null;
}

export type AppContext = {
  Bindings: Env;
  Variables: AppVariables;
};
