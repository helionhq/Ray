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

export function authorizedParties(siteUrl: string): string[] {
  const parties = new Set<string>();
  try {
    const site = new URL(siteUrl);
    parties.add(site.origin);
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
  } catch {
    // Invalid SITE_URL: fail closed by returning no authorized parties.
  }
  return [...parties];
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
): Promise<boolean> {
  const token = parseBearer(c.req.header("authorization"));
  if (!token) return false;

  let subject: string | null = null;
  try {
    const payload = await verifyToken(token, {
      secretKey: c.env.CLERK_SECRET_KEY,
      authorizedParties: authorizedParties(c.env.SITE_URL),
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
  if (!(await authenticateClerk(c))) return unauthorized(c);
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
  const ok = token?.startsWith("ray_")
    ? await authenticateDevice(c)
    : await authenticateClerk(c);
  if (!ok) return unauthorized(c);
  await next();
};
