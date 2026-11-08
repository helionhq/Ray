/**
 * Authentication middleware.
 *
 * - clerk:  Clerk session JWT from the site. The user's email/name is fetched
 *           from Clerk the first time we see them (or while email is still
 *           missing) and upserted into D1.
 * - device: opaque `ray_...` token from the desktop, looked up by SHA-256.
 * - either: device tokens are recognised by their prefix, everything else is
 *           treated as a Clerk JWT.
 */

import { createClerkClient, verifyToken } from "@clerk/backend";
import type { Context, MiddlewareHandler } from "hono";
import type { AppContext, UserRow } from "./env";
import {
  findDeviceByTokenHash,
  getUser,
  touchDevice,
  upsertUser,
} from "./db";
import { sha256Hex } from "./lib/crypto";
import { nowSeconds } from "./lib/weeks";
import { isDeviceToken, parseBearer } from "./lib/validation";

/** Refresh last_used_at at most once every five minutes per device. */
const DEVICE_TOUCH_INTERVAL_SECONDS = 300;

/**
 * Returns the configured site origin, or null when `SITE_URL` is missing or
 * invalid. Decision 12: callers must turn null into a 500 config error, never
 * an empty authorized-parties list.
 */
export function siteOrigin(siteUrl: string | undefined | null): string | null {
  const trimmed = (siteUrl ?? "").trim();
  if (trimmed === "") return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.hostname === "") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Clerk's `iss` claim is the Frontend API URL. The publishable key encodes it
 * as base64url(`<frontendApi>$`); deriving the issuer from that key pins
 * `iss` without another configured value. Returns null when the key is absent
 * or unparseable (e.g. a placeholder), in which case only authorizedParties
 * is enforced.
 */
export function clerkIssuer(
  publishableKey: string | undefined | null,
): string | null {
  const key = (publishableKey ?? "").trim();
  if (!key.startsWith("pk_test_") && !key.startsWith("pk_live_")) {
    return null;
  }
  const parts = key.split("_");
  if (parts.length !== 3 || !parts[2]) return null;
  const encoded = parts[2];
  const padded =
    encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
  let decoded: string;
  try {
    decoded = atob(padded);
  } catch {
    return null;
  }
  if (!decoded.endsWith("$")) return null;
  const frontendApi = decoded.slice(0, -1).trim().replace(/\/+$/u, "");
  if (frontendApi === "" || frontendApi.includes("$")) return null;
  const hostPart = frontendApi.replace(/^https?:\/\//iu, "");
  if (
    !/^[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~/-]*)?$/u.test(hostPart)
  ) {
    return null;
  }
  return /^https?:\/\//iu.test(frontendApi)
    ? frontendApi
    : `https://${frontendApi}`;
}

/**
 * Returns the Clerk authorized parties, or null when `SITE_URL` is invalid.
 * Same-origin production only; loopback dev origins are added when SITE_URL
 * is itself a loopback origin.
 */
export function authorizedParties(
  siteUrl: string | undefined | null,
): string[] | null {
  const origin = siteOrigin(siteUrl);
  if (!origin) return null;
  const site = new URL(origin);
  const parties = new Set<string>([site.origin]);
  const local =
    site.hostname === "localhost" ||
    site.hostname === "127.0.0.1" ||
    site.hostname === "[::1]";
  if (local) {
    // Vite's default port and wrangler dev's port, whichever loopback
    // spelling the browser uses.
    for (const hostname of ["localhost", "127.0.0.1"]) {
      parties.add(`${site.protocol}//${hostname}:5173`);
      parties.add(`${site.protocol}//${hostname}:8787`);
    }
  }
  return [...parties];
}

function configError(c: Context<AppContext>): Response {
  console.error("SITE_URL is missing or invalid; refusing Clerk verification");
  return c.json(
    {
      error: "config_error",
      message: "The server is not configured correctly.",
    },
    500,
  );
}

function unauthorized(c: Context<AppContext>): Response {
  return c.json(
    { error: "unauthorized", message: "Sign in to continue." },
    401,
  );
}

function primaryEmail(user: {
  primaryEmailAddressId: string | null;
  emailAddresses: ReadonlyArray<{ id: string; emailAddress: string }>;
}): string | null {
  const primary = user.emailAddresses.find(
    (address) => address.id === user.primaryEmailAddressId,
  );
  return primary?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null;
}

function displayName(user: {
  firstName: string | null;
  lastName: string | null;
  username: string | null;
}): string | null {
  const full = [user.firstName, user.lastName]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" ");
  return full !== "" ? full : (user.username ?? null);
}

async function resolveClerkUser(
  c: Context<AppContext>,
  userId: string,
): Promise<UserRow | null> {
  const existing = await getUser(c.env.DB, userId);
  if (existing?.email) return existing;

  let email: string | null = existing?.email ?? null;
  let name: string | null = existing?.name ?? null;
  try {
    const clerk = createClerkClient({
      secretKey: c.env.CLERK_SECRET_KEY,
      publishableKey: c.env.CLERK_PUBLISHABLE_KEY,
    });
    const profile = await clerk.users.getUser(userId);
    email = primaryEmail(profile) ?? email;
    name = displayName(profile) ?? name;
  } catch {
    // Clerk being briefly unavailable should not lock the user out of the
    // API. The row keeps email NULL so the next request retries the fetch.
  }

  return upsertUser(c.env.DB, {
    id: userId,
    email,
    name,
    createdAt: nowSeconds(),
  });
}

async function authenticateClerk(
  c: Context<AppContext>,
  parties: string[],
): Promise<boolean> {
  const token = parseBearer(c.req.header("authorization"));
  if (!token) return false;

  let subject: string | null = null;
  try {
    const issuer = clerkIssuer(c.env.CLERK_PUBLISHABLE_KEY);
    const payload = await verifyToken(token, {
      secretKey: c.env.CLERK_SECRET_KEY,
      authorizedParties: parties,
      ...(issuer === null ? {} : { issuer }),
    });
    subject = typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return false;
  }
  if (!subject) return false;

  const user = await resolveClerkUser(c, subject);
  if (!user) return false;

  c.set("user", user);
  c.set("authKind", "clerk");
  c.set("deviceId", null);
  return true;
}

async function authenticateDevice(
  c: Context<AppContext>,
): Promise<boolean> {
  const token = parseBearer(c.req.header("authorization"));
  if (!isDeviceToken(token)) return false;

  const tokenHash = await sha256Hex(token);
  const device = await findDeviceByTokenHash(c.env.DB, tokenHash);
  if (!device || device.revoked_at !== null) return false;

  const now = nowSeconds();
  if (
    device.last_used_at === null ||
    device.last_used_at < now - DEVICE_TOUCH_INTERVAL_SECONDS
  ) {
    await touchDevice(
      c.env.DB,
      device.id,
      now,
      now - DEVICE_TOUCH_INTERVAL_SECONDS,
    );
  }

  const user = await getUser(c.env.DB, device.user_id);
  if (!user) return false;

  c.set("user", user);
  c.set("authKind", "device");
  c.set("deviceId", device.id);
  return true;
}

export const requireClerk: MiddlewareHandler<AppContext> = async (
  c,
  next,
) => {
  const parties = authorizedParties(c.env.SITE_URL);
  if (parties === null) return configError(c);
  if (!(await authenticateClerk(c, parties))) return unauthorized(c);
  await next();
};

export const requireDevice: MiddlewareHandler<AppContext> = async (
  c,
  next,
) => {
  if (!(await authenticateDevice(c))) return unauthorized(c);
  await next();
};

export const requireEither: MiddlewareHandler<AppContext> = async (
  c,
  next,
) => {
  const token = parseBearer(c.req.header("authorization"));
  if (token?.startsWith("ray_")) {
    if (!(await authenticateDevice(c))) return unauthorized(c);
  } else {
    const parties = authorizedParties(c.env.SITE_URL);
    if (parties === null) return configError(c);
    if (!(await authenticateClerk(c, parties))) return unauthorized(c);
  }
  await next();
};
