/**
 * STT abuse guards (review decisions 3 and M2):
 *
 * - at most two in-flight STT requests per user (D1 lease, released in
 *   `finally`, with a six-minute expiry if a release is lost);
 * - failed transcriptions do not consume words, so they are counted per week
 *   and a generous failure budget cuts off clearly abusive retry loops.
 *
 * Requests that never reach the upstream (401/402/413/429, invalid input) are
 * not counted as failures.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { AppContext } from "./env";
import {
  acquireSttLease,
  addSttFailure,
  getSttFailures,
  releaseSttLease,
  STT_LEASE_LIMIT,
  STT_LEASE_TTL_SECONDS,
} from "./db";
import { isoFromUnixSeconds, nowSeconds, weekBounds } from "./lib/weeks";

/** Generous weekly cap on failed STT attempts (M2). */
export const STT_WEEKLY_FAILURE_LIMIT = 200;

function tooMany(
  c: Context<AppContext>,
  message: string,
  resetsAt?: number,
): Response {
  return c.json(
    {
      error: "too_many_requests",
      message,
      ...(resetsAt === undefined
        ? {}
        : { resets_at: isoFromUnixSeconds(resetsAt) }),
    },
    429,
  );
}

export const sttGuard: MiddlewareHandler<AppContext> = async (c, next) => {
  const user = c.get("user");
  const now = nowSeconds();
  const week = weekBounds(now);

  const failures = await getSttFailures(c.env.DB, user.id, week.weekStart);
  if (failures >= STT_WEEKLY_FAILURE_LIMIT) {
    return tooMany(
      c,
      "Too many failed transcription attempts this week.",
      week.resetsAt,
    );
  }

  const leaseId = `lease_${crypto.randomUUID()}`;
  const acquired = await acquireSttLease(
    c.env.DB,
    leaseId,
    user.id,
    now,
    now + STT_LEASE_TTL_SECONDS,
    STT_LEASE_LIMIT,
  );
  if (!acquired) {
    return tooMany(c, "Too many dictations are already in progress.");
  }

  try {
    await next();
    if (c.res.status >= 500) {
      try {
        await addSttFailure(c.env.DB, user.id, week.weekStart);
      } catch {
        // Failure accounting is best effort; never break the response.
      }
    }
  } finally {
    try {
      await releaseSttLease(c.env.DB, leaseId);
    } catch {
      // The lease expires on its own after six minutes; never turn a
      // successful transcription into a 500 because cleanup failed.
      console.error("failed to release stt lease");
    }
  }
};
