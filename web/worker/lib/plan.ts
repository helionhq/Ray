/**
 * Plan resolution from stored Creem subscriptions.
 *
 * Pro: only subscriptions for one of the two configured Creem products, with
 * status `active` or `trialing`, or `canceled`/`scheduled_cancel` while the
 * paid period has not ended yet. Everything else is Starter.
 */

import type { SubscriptionRow } from "../env";

export type PlanName = "starter" | "pro";
export type PlanInterval = "monthly" | "annual";
export type BillingIssue = "past_due" | "unpaid" | "paused";

/** The no-card Pro trial runs for 14 days from the first desktop sign-in. */
export const TRIAL_DAYS = 14;
export const TRIAL_SECONDS = TRIAL_DAYS * 86_400;

export interface PlanView {
  plan: PlanName;
  interval: PlanInterval | null;
  status: string | null;
  cancel_at_period_end: boolean;
  /** Unix seconds. */
  current_period_end: number | null;
  subscription_id: string | null;
  /**
   * Unix seconds when the active no-card Pro trial ends. Null for paid
   * subscriptions and Starter: while non-null the account resolves as Pro
   * but `interval`/`status` stay null because there is no subscription.
   */
  trial_ends_at: number | null;
}

export interface TrialState {
  /** Unix seconds; null when the trial never started. */
  startedAt: number | null;
  /** Free-blocked accounts can never be on a trial. */
  freeBlocked: boolean;
}

const NO_TRIAL: TrialState = { startedAt: null, freeBlocked: false };

/**
 * The only product ids allowed to grant Pro. Placeholder/empty values are
 * discarded so an unconfigured deployment fails closed.
 */
export function entitledProductIds(env: {
  CREEM_PRODUCT_PRO_MONTHLY: string;
  CREEM_PRODUCT_PRO_ANNUAL: string;
}): string[] {
  return [env.CREEM_PRODUCT_PRO_MONTHLY, env.CREEM_PRODUCT_PRO_ANNUAL]
    .map((productId) => (productId ?? "").trim())
    .filter(
      (productId) => productId !== "" && !productId.includes("REPLACE"),
    );
}

/**
 * Terminal statuses win equal-`updated_at` webhook ordering. A refund or
 * dispute must never be overwritten by an `active` event that shares the same
 * timestamp.
 */
export function terminalStatusRank(
  status: string | null | undefined,
): number {
  switch (status) {
    case "revoked":
      return 3;
    case "expired":
      return 2;
    case "unpaid":
      return 1;
    default:
      return 0;
  }
}

function isAllowedProduct(
  productId: string | null,
  entitledProducts: readonly string[],
): boolean {
  return productId !== null && entitledProducts.includes(productId);
}

type EntitlementFields = Pick<
  SubscriptionRow,
  "status" | "current_period_end" | "product_id"
>;

export function isEntitled(
  subscription: EntitlementFields,
  nowSeconds: number,
  entitledProducts: readonly string[],
): boolean {
  if (!isAllowedProduct(subscription.product_id, entitledProducts)) {
    return false;
  }
  if (
    subscription.status === "active" ||
    subscription.status === "trialing"
  ) {
    return true;
  }
  if (
    subscription.status === "canceled" ||
    subscription.status === "scheduled_cancel"
  ) {
    return (
      subscription.current_period_end !== null &&
      subscription.current_period_end > nowSeconds
    );
  }
  return false;
}

export function statusRank(status: string): number {
  switch (status) {
    case "active":
      return 5;
    case "trialing":
      return 4;
    case "scheduled_cancel":
    case "canceled":
      return 3;
    case "past_due":
      return 2;
    case "unpaid":
      return 1;
    default:
      return 0;
  }
}

export function normalizeInterval(
  value: unknown,
): PlanInterval | null {
  if (typeof value !== "string") return null;
  switch (value.trim().toLowerCase()) {
    case "month":
    case "monthly":
    case "mo":
      return "monthly";
    case "year":
    case "yearly":
    case "annual":
    case "annually":
    case "yr":
      return "annual";
    default:
      return null;
  }
}

function storedInterval(value: string | null): PlanInterval | null {
  return value === "monthly" || value === "annual" ? value : null;
}

function toView(subscription: SubscriptionRow, plan: PlanName): PlanView {
  return {
    plan,
    interval: storedInterval(subscription.interval),
    status: subscription.status,
    cancel_at_period_end: subscription.cancel_at_period_end !== 0,
    current_period_end: subscription.current_period_end,
    subscription_id: subscription.id,
    trial_ends_at: null,
  };
}

const STARTER: PlanView = {
  plan: "starter",
  interval: null,
  status: null,
  cancel_at_period_end: false,
  current_period_end: null,
  subscription_id: null,
  trial_ends_at: null,
};

/** When the trial ends, or null when it never started / is suppressed. */
export function trialEndsAt(trial: TrialState): number | null {
  if (trial.startedAt === null || trial.freeBlocked) return null;
  return trial.startedAt + TRIAL_SECONDS;
}

function trialView(trial: TrialState, nowSeconds: number): PlanView | null {
  const endsAt = trialEndsAt(trial);
  if (endsAt === null || nowSeconds >= endsAt) return null;
  return {
    plan: "pro",
    interval: null,
    status: null,
    cancel_at_period_end: false,
    current_period_end: null,
    subscription_id: null,
    trial_ends_at: endsAt,
  };
}

/**
 * Chooses the subscription that best describes the user's current state.
 * Entitled subscriptions win (active before trialing before a scheduled
 * cancellation), otherwise the most recently updated row is shown so the
 * account page can still display "canceled"/"expired"/"revoked".
 *
 * A paid subscription always takes precedence over the trial. Once any
 * subscription row exists the trial is never used again, matching the rule
 * that only accounts that never subscribed can start one.
 */
export function resolvePlan(
  subscriptions: readonly SubscriptionRow[],
  nowSeconds: number,
  entitledProducts: readonly string[],
  trial: TrialState = NO_TRIAL,
): PlanView {
  if (subscriptions.length === 0) {
    return trialView(trial, nowSeconds) ?? STARTER;
  }

  const entitled = subscriptions.filter((subscription) =>
    isEntitled(subscription, nowSeconds, entitledProducts),
  );

  if (entitled.length > 0) {
    const chosen = [...entitled].sort(
      (a, b) =>
        statusRank(b.status) - statusRank(a.status) ||
        b.updated_at - a.updated_at ||
        a.id.localeCompare(b.id),
    )[0]!;
    return toView(chosen, "pro");
  }

  const chosen = [...subscriptions].sort(
    (a, b) =>
      b.updated_at - a.updated_at ||
      terminalStatusRank(b.status) - terminalStatusRank(a.status) ||
      statusRank(b.status) - statusRank(a.status) ||
      a.id.localeCompare(b.id),
  )[0]!;
  return toView(chosen, "starter");
}

/**
 * A payment-method problem for a subscription that still exists but no longer
 * grants Pro. Only reported while the account is on Starter.
 */
export function resolveBillingIssue(view: PlanView): BillingIssue | null {
  if (view.plan === "pro") return null;
  switch (view.status) {
    case "past_due":
    case "unpaid":
    case "paused":
      return view.status;
    default:
      return null;
  }
}
