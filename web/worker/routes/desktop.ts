/**
 * Desktop browser sign-in hand-off.
 *
 * The site exchanges a Clerk session JWT for a one-time code bound to a PKCE
 * challenge; the desktop exchanges the code + verifier for an opaque device
 * token. Codes are stored hashed, expire after five minutes and are consumed
 * atomically so a replay loses.
 */

import type { Hono } from "hono";
import type { AppContext } from "../env";
import { requireClerk, requireDevice } from "../auth";
import {
  consumeAuthCode,
  createAuthCode,
  createDevice,
  deleteExpiredAuthCodes,
  findAuthCode,
  getUser,
  markFreeBlockedIfOverDeviceLimitStatement,
  revokeAllDevices,
  revokeDevice,
  startTrialStatement,
} from "../db";
import {
  pkceChallenge,
  randomToken,
  sha256Hex,
  timingSafeEqualString,
} from "../lib/crypto";
import {
  allowRequest,
  clientIp,
  rateLimitIp,
  rateLimitUser,
} from "../lib/rate-limit";
import { nowSeconds } from "../lib/weeks";
import { isBase64Url32 } from "../lib/validation";
import { parseJsonObject, readBodyLimited } from "../http";

const AUTH_CODE_TTL_SECONDS = 300;

export function registerDesktopRoutes(app: Hono<AppContext>): void {
  app.post(
    "/api/desktop/authorize",
    requireClerk,
    rateLimitUser("RATE_LIMIT_AUTHORIZE"),
    async (c) => {
      const body = await readBodyLimited(c, 4_096);
      if (!body.ok) {
        return c.json(
          {
            error: "invalid_request",
            message: "Request body is too large.",
          },
          400,
        );
      }
      const json = parseJsonObject(body.text);
      if (!json) {
        return c.json(
          { error: "invalid_request", message: "Expected a JSON object." },
          400,
        );
      }
      const state = json["state"];
      const challenge = json["challenge"];
      if (!isBase64Url32(state) || !isBase64Url32(challenge)) {
        return c.json(
          {
            error: "invalid_request",
            message: "state and challenge must be 32-byte base64url values.",
          },
          400,
        );
      }

      const user = c.get("user");
      const now = nowSeconds();
      const code = randomToken(32);
      const codeHash = await sha256Hex(code);

      await deleteExpiredAuthCodes(c.env.DB, now);
      await createAuthCode(c.env.DB, {
        codeHash,
        userId: user.id,
        challenge,
        state,
        expiresAt: now + AUTH_CODE_TTL_SECONDS,
      });

      // The site navigates to this custom-scheme URL; the desktop checks
      // state.
      const redirect =
        `ray://auth/callback?code=${encodeURIComponent(code)}` +
        `&state=${encodeURIComponent(state)}`;

      return c.json({ code, redirect });
    },
  );

  app.post(
    "/api/desktop/token",
    rateLimitIp("RATE_LIMIT_DESKTOP_TOKEN"),
    async (c) => {
      // Unauthenticated endpoint: reject malformed input before any DB work.
      const body = await readBodyLimited(c, 2_048);
      if (!body.ok) {
        return c.json(
          {
            error: "invalid_request",
            message: "Request body is too large.",
          },
          400,
        );
      }
      const json = parseJsonObject(body.text);
      if (!json) {
        return c.json(
          { error: "invalid_request", message: "Expected a JSON object." },
          400,
        );
      }
      const code = json["code"];
      const verifier = json["verifier"];
      if (!isBase64Url32(code) || !isBase64Url32(verifier)) {
        return c.json(
          {
            error: "invalid_request",
            message: "code and verifier must be 32-byte base64url values.",
          },
          400,
        );
      }
      // Required: the per-PC free limit and the trial both depend on it.
      // Every desktop build sends it; a missing or malformed value is a
      // client bug, not a request to silently skip both rules.
      const deviceId = json["device_id"];
      if (!isBase64Url32(deviceId)) {
        return c.json(
          {
            error: "invalid_request",
            message:
              "device_id is required and must be a 32-byte base64url value.",
          },
          400,
        );
      }

      const now = nowSeconds();
      const codeHash = await sha256Hex(code);
      const authCode = await findAuthCode(c.env.DB, codeHash);
      if (
        !authCode ||
        authCode.used_at !== null ||
        authCode.expires_at <= now
      ) {
        return c.json(
          {
            error: "invalid_code",
            message: "This sign-in link is invalid or has expired.",
          },
          400,
        );
      }

      const computedChallenge = await pkceChallenge(verifier);
      if (!timingSafeEqualString(computedChallenge, authCode.challenge)) {
        return c.json(
          {
            error: "invalid_verifier",
            message: "The sign-in verifier does not match.",
          },
          400,
        );
      }

      // Atomic single-use: only one concurrent request can win this UPDATE.
      if (!(await consumeAuthCode(c.env.DB, codeHash, now))) {
        return c.json(
          {
            error: "invalid_code",
            message: "This sign-in link is invalid or has expired.",
          },
          400,
        );
      }

      // Do not mint a device token for a deleted user (Clerk `user.deleted`).
      const user = await getUser(c.env.DB, authCode.user_id);
      if (!user) {
        return c.json(
          {
            error: "invalid_code",
            message: "This sign-in link is invalid or has expired.",
          },
          400,
        );
      }

      const token = `ray_${randomToken(32)}`;
      const tokenHash = await sha256Hex(token);
      // The desktop sends base64url(SHA-256("ray-device-v1:" + MachineGuid));
      // the Worker stores SHA-256 of that value. Neither side can recover the
      // raw hardware id, and the second hash is only used to count accounts.
      const deviceHash = await sha256Hex(deviceId);
      const deviceRowId = `dev_${crypto.randomUUID()}`;
      await createDevice(c.env.DB, {
        id: deviceRowId,
        userId: authCode.user_id,
        tokenHash,
        createdAt: now,
        deviceHash,
      });

      // The row must exist before the decision: the conditional UPDATE orders
      // rows by created_at/rowid, so concurrent sign-ins serialize to exactly
      // three free accounts and a re-sign-in by an account that was already
      // here is never blocked.
      const blockedResult = await markFreeBlockedIfOverDeviceLimitStatement(
        c.env.DB,
        { userId: authCode.user_id, deviceRowId, now },
      ).run();
      const newlyBlocked = (blockedResult.meta.changes ?? 0) > 0;

      // The no-card 14-day trial starts on the first successful desktop
      // sign-in only: never on site-only sign-up, never when a subscription
      // has ever existed, and never once a PC-level free block or trial is
      // already in place. `startTrialStatement` enforces those conditions
      // atomically. The per-IP limiter is a brake on trial farming with fresh
      // accounts and device ids: over the limit, sign-in still succeeds but
      // no trial is granted.
      if (
        !newlyBlocked &&
        user.trial_started_at === null &&
        user.free_blocked_at === null &&
        (await allowRequest(
          c.env.RATE_LIMIT_TRIAL,
          "RATE_LIMIT_TRIAL",
          `ip:${clientIp(c)}`,
        ))
      ) {
        await startTrialStatement(c.env.DB, authCode.user_id, now).run();
      }

      return c.json({
        token,
        user: {
          id: authCode.user_id,
          email: user.email ?? "",
          name: user.name,
        },
      });
    },
  );

  app.post("/api/desktop/signout", requireDevice, async (c) => {
    const deviceId = c.get("deviceId");
    if (deviceId) {
      await revokeDevice(c.env.DB, deviceId, nowSeconds());
    }
    return c.json({ ok: true });
  });

  app.post(
    "/api/devices/revoke-all",
    requireClerk,
    rateLimitUser("RATE_LIMIT_REVOKE_ALL"),
    async (c) => {
      const revoked = await revokeAllDevices(
        c.env.DB,
        c.get("user").id,
        nowSeconds(),
      );
      return c.json({ ok: true, revoked });
    },
  );
}
