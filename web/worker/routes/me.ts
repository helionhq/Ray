import type { Hono } from "hono";
import type { AppContext } from "../env";
import {
  getUsage,
  listSubscriptions,
  startTrialStatement,
  usageForPlan,
} from "../db";
import { requireEither } from "../auth";
import {
  entitledProductIds,
  proEndedAtThisWeek,
  resolveBillingIssue,
  resolvePlan,
} from "../lib/plan";
import { quotaLimits } from "../lib/quota";
import { allowRequest, clientIp } from "../lib/rate-limit";
import { isoFromUnixSeconds, nowSeconds, weekBounds } from "../lib/weeks";

export function registerMeRoutes(app: Hono<AppContext>): void {
  app.get("/api/me", requireEither, async (c) => {
    const user = c.get("user");
    const now = nowSeconds();
    const week = weekBounds(now);
    const [subscriptions, rawUsage] = await Promise.all([
      listSubscriptions(c.env.DB, user.id),
      getUsage(c.env.DB, user.id, week.weekStart),
    ]);

    // The trial is normally granted at desktop token exchange. If that
    // attempt was denied by the per-IP brake, retry it on an authenticated
    // device request so a signed-in user does not silently lose the
    // advertised trial. The same eligibility rules and limiter apply, and
    // `startTrialStatement` re-checks them atomically.
    if (
      c.get("authKind") === "device" &&
      user.trial_started_at === null &&
      user.free_blocked_at === null &&
      subscriptions.length === 0 &&
      (await allowRequest(
        c.env.RATE_LIMIT_TRIAL,
        "RATE_LIMIT_TRIAL",
        `ip:${clientIp(c)}`,
      ))
    ) {
      const started = await startTrialStatement(
        c.env.DB,
        user.id,
        now,
      ).run();
      if ((started.meta.changes ?? 0) > 0) user.trial_started_at = now;
    }

    const trial = {
      startedAt: user.trial_started_at,
      freeBlocked: user.free_blocked_at !== null,
    };
    const products = entitledProductIds(c.env);
    const plan = resolvePlan(subscriptions, now, products, trial);
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
