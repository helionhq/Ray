export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface ErrorBody {
  error?: unknown;
  message?: unknown;
}

const FALLBACK_MESSAGES: Record<number, string> = {
  400: "That request didn't look right. Please try again.",
  401: "Your session expired. Sign in again to continue.",
  402: "You've reached this week's limit.",
  403: "You don't have access to that.",
  404: "We couldn't find what you were looking for.",
  409: "That action has already been taken.",
  429: "Too many requests. Give it a moment and try again.",
  500: "Something went wrong on our side. Please try again.",
};

const RATE_LIMITED_MESSAGE =
  "Ray is getting a lot of requests right now. Wait a few seconds, then try again.";

export function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

async function requestJson<T>(
  path: string,
  init: RequestInit & { token?: string | null } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError(
      0,
      "network_error",
      "Couldn't reach Ray. Check your connection and try again.",
    );
  }

  if (!response.ok) {
    let body: ErrorBody | null = null;
    try {
      body = (await response.json()) as ErrorBody;
    } catch {
      // A non-JSON error page (proxy, outage) gets the status fallback.
    }
    const code =
      typeof body?.error === "string" ? body.error : "request_failed";
    // The Worker's rate-limit middleware and its STT concurrency/failure
    // brakes all send `429 { error: "too_many_requests" }` (older builds used
    // `rate_limited`). Treat any 429 without its own message as rate-limited
    // so the user gets a friendly retry line instead of the generic fallback.
    const fallback =
      response.status === 429
        ? RATE_LIMITED_MESSAGE
        : (FALLBACK_MESSAGES[response.status] ??
          "Something went wrong. Please try again.");
    const message =
      typeof body?.message === "string" && body.message.trim()
        ? body.message
        : fallback;
    throw new ApiError(response.status, code, message);
  }

  return (await response.json()) as T;
}

export interface MeResponse {
  user: {
    id: string;
    /** Never null: the API sends an empty string when the email is unknown. */
    email: string;
    name: string | null;
  };
  plan: "starter" | "pro";
  interval: "monthly" | "annual" | null;
  status: string | null;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
  /** Present on a subscription that still exists but no longer grants Pro. */
  billing_issue: "past_due" | "unpaid" | "paused" | null;
  /**
   * The no-card 14-day Pro trial. While non-null `plan` is "pro" but
   * `interval` and `status` stay null because there is no subscription.
   */
  trial: { ends_at: string } | null;
  /** True when this account is over the per-PC free-account limit. */
  free_blocked: boolean;
  usage: {
    words_used: number;
    words_limit: number | null;
    week_start: string | null;
    resets_at: string | null;
  };
}

export function fetchMe(token: string) {
  return requestJson<MeResponse>("/api/me", { method: "GET", token });
}

export function createCheckout(
  token: string,
  interval: "monthly" | "annual",
) {
  return requestJson<{ url: string }>("/api/billing/checkout", {
    method: "POST",
    token,
    body: JSON.stringify({ interval }),
  });
}

export function createPortalSession(token: string) {
  return requestJson<{ url: string }>("/api/billing/portal", {
    method: "POST",
    token,
  });
}

/** Revokes every desktop device token for the signed-in account. */
export function revokeAllDevices(token: string) {
  return requestJson<{ ok: boolean; revoked: number }>(
    "/api/devices/revoke-all",
    {
      method: "POST",
      token,
    },
  );
}

export interface DesktopAuthorizeResponse {
  code: string;
  redirect: string;
}

export function authorizeDesktop(
  token: string,
  state: string,
  challenge: string,
) {
  return requestJson<DesktopAuthorizeResponse>("/api/desktop/authorize", {
    method: "POST",
    token,
    body: JSON.stringify({ state, challenge }),
  });
}

/** The desktop hand-off must only ever navigate back into the Ray app. */
export function isRayAuthRedirect(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^ray:\/\/auth\/callback\?[^\s]+$/.test(value)
  );
}
