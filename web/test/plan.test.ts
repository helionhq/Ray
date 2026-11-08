import { describe, expect, it } from "vitest";
import type { SubscriptionRow } from "../worker/env";
import {
  isEntitled,
  normalizeInterval,
  resolvePlan,
} from "../worker/lib/plan";

const NOW = Math.floor(Date.parse("2026-11-08T12:00:00Z") / 1000);
const FUTURE = NOW + 10 * 86_400;
const PAST = NOW - 10 * 86_400;

function subscription(
  overrides: Partial<SubscriptionRow> = {},
): SubscriptionRow {
  return {
    id: "sub_default",
    user_id: "user_1",
    product_id: "prod_monthly",
    interval: "monthly",
    status: "active",
    current_period_end: FUTURE,
    cancel_at_period_end: 0,
    updated_at: NOW,
    ...overrides,
  };
}

describe("isEntitled", () => {
  it("grants Pro for active and trialing subscriptions", () => {
    expect(isEntitled(subscription({ status: "active" }), NOW)).toBe(true);
    expect(isEntitled(subscription({ status: "trialing" }), NOW)).toBe(true);
  });

  it("grants Pro for canceled/scheduled_cancel before period end", () => {
    expect(
      isEntitled(
        subscription({ status: "canceled", current_period_end: FUTURE }),
        NOW,
      ),
    ).toBe(true);
    expect(
      isEntitled(
        subscription({
          status: "scheduled_cancel",
          current_period_end: FUTURE,
        }),
        NOW,
      ),
    ).toBe(true);
  });

  it("does not grant Pro after the period ends", () => {
    expect(
      isEntitled(
        subscription({ status: "canceled", current_period_end: PAST }),
        NOW,
      ),
    ).toBe(false);
    expect(
      isEntitled(
        subscription({ status: "canceled", current_period_end: null }),
        NOW,
      ),
    ).toBe(false);
  });

  it("does not grant Pro for expired, past_due, unpaid or paused", () => {
    for (const status of [
      "expired",
      "past_due",
      "unpaid",
      "paused",
      "scheduled_cancel",
    ]) {
      expect(
        isEntitled(
          subscription({ status, current_period_end: PAST }),
          NOW,
        ),
      ).toBe(false);
    }
  });
});

describe("resolvePlan", () => {
  it("returns Starter with nulls when there are no subscriptions", () => {
    expect(resolvePlan([], NOW)).toEqual({
      plan: "starter",
      interval: null,
      status: null,
      cancel_at_period_end: false,
      current_period_end: null,
      subscription_id: null,
    });
  });

  it("returns Pro for an active monthly subscription", () => {
    const view = resolvePlan([subscription()], NOW);
    expect(view.plan).toBe("pro");
    expect(view.interval).toBe("monthly");
    expect(view.status).toBe("active");
    expect(view.cancel_at_period_end).toBe(false);
  });

  it("prefers an active subscription over a canceled-but-entitled one", () => {
    const view = resolvePlan(
      [
        subscription({
          id: "sub_scheduled",
          status: "scheduled_cancel",
          cancel_at_period_end: 1,
          updated_at: NOW + 100,
          interval: "annual",
        }),
        subscription({
          id: "sub_active",
          status: "active",
          interval: "monthly",
          updated_at: NOW,
        }),
      ],
      NOW,
    );
    expect(view.plan).toBe("pro");
    expect(view.subscription_id).toBe("sub_active");
    expect(view.interval).toBe("monthly");
  });

  it("reports cancel_at_period_end for a scheduled cancellation", () => {
    const view = resolvePlan(
      [subscription({ status: "scheduled_cancel", cancel_at_period_end: 1 })],
      NOW,
    );
    expect(view.plan).toBe("pro");
    expect(view.cancel_at_period_end).toBe(true);
    expect(view.status).toBe("scheduled_cancel");
  });

  it("returns Starter for a canceled subscription past its period", () => {
    const view = resolvePlan(
      [
        subscription({
          status: "canceled",
          current_period_end: PAST,
          cancel_at_period_end: 0,
        }),
      ],
      NOW,
    );
    expect(view.plan).toBe("starter");
    expect(view.status).toBe("canceled");
    expect(view.current_period_end).toBe(PAST);
  });

  it("returns Starter for expired and past_due subscriptions", () => {
    expect(
      resolvePlan(
        [subscription({ status: "expired", current_period_end: PAST })],
        NOW,
      ).plan,
    ).toBe("starter");
    expect(
      resolvePlan(
        [subscription({ status: "past_due", current_period_end: FUTURE })],
        NOW,
      ).plan,
    ).toBe("starter");
  });

  it("shows the most recently updated row when nothing is entitled", () => {
    const view = resolvePlan(
      [
        subscription({
          id: "sub_old",
          status: "canceled",
          current_period_end: PAST,
          updated_at: NOW - 1_000,
        }),
        subscription({
          id: "sub_new",
          status: "expired",
          current_period_end: PAST,
          interval: "annual",
          updated_at: NOW - 10,
        }),
      ],
      NOW,
    );
    expect(view.plan).toBe("starter");
    expect(view.subscription_id).toBe("sub_new");
    expect(view.interval).toBe("annual");
  });

  it("normalises stored intervals", () => {
    const view = resolvePlan(
      [subscription({ interval: "annual" })],
      NOW,
    );
    expect(view.interval).toBe("annual");
    expect(
      resolvePlan([subscription({ interval: "week" })], NOW).interval,
    ).toBeNull();
  });
});

describe("normalizeInterval", () => {
  it("recognises Creem and SDK spellings", () => {
    expect(normalizeInterval("month")).toBe("monthly");
    expect(normalizeInterval("monthly")).toBe("monthly");
    expect(normalizeInterval("year")).toBe("annual");
    expect(normalizeInterval("annual")).toBe("annual");
    expect(normalizeInterval("ANNUALLY")).toBe("annual");
  });

  it("rejects unknown values", () => {
    expect(normalizeInterval("week")).toBeNull();
    expect(normalizeInterval(null)).toBeNull();
    expect(normalizeInterval(7)).toBeNull();
  });
});
