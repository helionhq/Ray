/**
 * Quota gate for every proxied inference call. It runs after authentication
 * and before the request body is touched, so an over-quota desktop never
 * uploads audio.
 */

import type { MiddlewareHandler } from "hono";
import type { AppContext } from "./env";
import { getUsageWords, listSubscriptions } from "./db";
import { resolvePlan } from "./lib/plan";
import { decideQuota, quotaLimits } from "./lib/quota";
import { isoFromUnixSeconds, nowSeconds, weekBounds } from "./lib/weeks";

export const quotaGuard: MiddlewareHandler<AppContext> = async (c, next) => {
  const user = c.get("user");
  const now = nowSeconds();
  const week = weekBounds(now);
  const [subscriptions, wordsUsed] = await Promise.all([
    listSubscriptions(c.env.DB, user.id),
    getUsageWords(c.env.DB, user.id, week.weekStart),
  ]);
  const plan = resolvePlan(subscriptions, now);
  const decision = decideQuota(
    plan.plan,
    wordsUsed,
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
