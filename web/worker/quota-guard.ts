/**
 * Quota gate for every proxied inference call. It runs after authentication
 * and before the request body is touched, so an over-quota desktop never
 * uploads audio.
 */

import type { MiddlewareHandler } from "hono";
import type { AppContext } from "./env";
import { getUsage, listSubscriptions, usageForPlan } from "./db";
import {
  entitledProductIds,
  proEndedAtThisWeek,
  resolvePlan,
} from "./lib/plan";
import { decideQuota, quotaLimits } from "./lib/quota";
import { isoFromUnixSeconds, nowSeconds, weekBounds } from "./lib/weeks";

export const quotaGuard: MiddlewareHandler<AppContext> = async (c, next) => {
  const user = c.get("user");
  const now = nowSeconds();
  const week = weekBounds(now);
  const trial = {
    startedAt: user.trial_started_at,
    freeBlocked: user.free_blocked_at !== null,
  };
  const [subscriptions, rawUsage] = await Promise.all([
    listSubscriptions(c.env.DB, user.id),
    getUsage(c.env.DB, user.id, week.weekStart),
  ]);
  const products = entitledProductIds(c.env);
  const plan = resolvePlan(
    subscriptions,
    now,
    products,
    trial,
  );

  // Trial-farming protection: a free-blocked account cannot dictate without a
  // paid subscription. Sign-in still works so the upgrade buttons remain
  // reachable. This runs before the quota check: it applies even when the
  // weekly usage is still low.
  if (user.free_blocked_at !== null && plan.plan !== "pro") {
    return c.json(
      {
        error: "device_limit",
        message:
          "This account can't use the free plan because too many accounts were created on one PC. Upgrade to Pro to keep dictating.",
      },
      402,
    );
  }

  const usage = await usageForPlan(
    c.env.DB,
    user,
    week.weekStart,
    rawUsage,
    proEndedAtThisWeek(
      plan,
      subscriptions,
      trial,
      products,
      now,
      week.weekStart,
    ),
  );

  const decision = decideQuota(
    plan.trial_ends_at !== null ? "trial" : plan.plan,
    usage.words,
    usage.audioSeconds,
    quotaLimits(c.env),
    week.resetsAt,
  );

  if (!decision.allowed) {
    if (decision.reason === "starter_limit") {
      return c.json(
        {
          error: "quota_exceeded",
          message: "Weekly limit reached. It resets Monday.",
          plan: "starter",
          words_used: decision.wordsUsed,
          words_limit: decision.wordsLimit,
          resets_at: isoFromUnixSeconds(decision.resetsAt),
        },
        402,
      );
    }
    return c.json(
      {
        error: "fair_use",
        message: "Fair-use limit reached. It resets Monday.",
        resets_at: isoFromUnixSeconds(decision.resetsAt),
      },
      429,
    );
  }

  await next();
};
