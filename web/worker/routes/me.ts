import type { Hono } from "hono";
import type { AppContext } from "../env";
import { getUsage, listSubscriptions, usageForPlan } from "../db";
import { requireEither } from "../auth";
import {
  entitledProductIds,
  resolveBillingIssue,
  resolvePlan,
  trialEndedThisWeek,
} from "../lib/plan";
import { quotaLimits } from "../lib/quota";
import { isoFromUnixSeconds, nowSeconds, weekBounds } from "../lib/weeks";

export function registerMeRoutes(app: Hono<AppContext>): void {
  app.get("/api/me", requireEither, async (c) => {
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
    const plan = resolvePlan(
      subscriptions,
      now,
      entitledProductIds(c.env),
      trial,
    );
    const usage = await usageForPlan(
      c.env.DB,
      user,
      week.weekStart,
      rawUsage,
      trialEndedThisWeek(plan, subscriptions, trial, now, week.weekStart),
    );
    const limits = quotaLimits(c.env);

    return c.json({
      user: {
        id: user.id,
        // Decision 9: never null; the empty string means "unknown".
        email: user.email ?? "",
        name: user.name,
      },
      plan: plan.plan,
      interval: plan.interval,
      status: plan.status,
      cancel_at_period_end: plan.cancel_at_period_end,
      current_period_end:
        plan.current_period_end === null
          ? null
          : isoFromUnixSeconds(plan.current_period_end),
      billing_issue: resolveBillingIssue(plan),
      // The no-card trial resolves as Pro but is never a subscription:
      // `interval`/`status` stay null while `trial` is present.
      trial:
        plan.trial_ends_at === null
          ? null
          : { ends_at: isoFromUnixSeconds(plan.trial_ends_at) },
      // Set when this account is over the per-PC free-account limit.
      free_blocked: user.free_blocked_at !== null,
      usage: {
        words_used: usage.words,
        // The Pro fair-use and trial audio caps are deliberately hidden from
        // clients; only Starter has a visible word limit.
        words_limit:
          plan.plan === "starter" ? limits.starterWeeklyWords : null,
        week_start: isoFromUnixSeconds(week.weekStart),
        resets_at: isoFromUnixSeconds(week.resetsAt),
      },
    });
  });
}
