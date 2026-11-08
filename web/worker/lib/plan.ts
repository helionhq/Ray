/**
 * Plan resolution from stored Creem subscriptions.
 *
 * Pro: status `active` or `trialing`, or `canceled`/`scheduled_cancel` while
 * the paid period has not ended yet. Everything else is Starter.
 */

import type { SubscriptionRow } from "../env";

export type PlanName = "starter" | "pro";
export type PlanInterval = "monthly" | "annual";

export interface PlanView {
  plan: PlanName;
  interval: PlanInterval | null;
  status: string | null;
  cancel_at_period_end: boolean;
  /** Unix seconds. */
  current_period_end: number | null;
  subscription_id: string | null;
}

type EntitlementFields = Pick<
  SubscriptionRow,
  "status" | "current_period_end"
>;

export function isEntitled(
  subscription: EntitlementFields,
  nowSeconds: number,
): boolean {
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
  };
}

const STARTER: PlanView = {
  plan: "starter",
  interval: null,
  status: null,
  cancel_at_period_end: false,
  current_period_end: null,
  subscription_id: null,
};

/**
 * Chooses the subscription that best describes the user's current state.
 * Entitled subscriptions win (active before trialing before a scheduled
 * cancellation), otherwise the most recently updated row is shown so the
 * account page can still display "canceled"/"expired".
 */
export function resolvePlan(
  subscriptions: readonly SubscriptionRow[],
  nowSeconds: number,
): PlanView {
  if (subscriptions.length === 0) return STARTER;

  const entitled = subscriptions.filter((subscription) =>
    isEntitled(subscription, nowSeconds),
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
      statusRank(b.status) - statusRank(a.status) ||
      a.id.localeCompare(b.id),
  )[0]!;
  return toView(chosen, "starter");
}
