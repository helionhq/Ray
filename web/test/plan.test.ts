import { describe, expect, it } from "vitest";
import type { SubscriptionRow } from "../worker/env";
import {
  TRIAL_SECONDS,
  entitledProductIds,
  isEntitled,
  normalizeInterval,
  proEndedThisWeek,
  resolveBillingIssue,
  resolvePlan,
  terminalStatusRank,
} from "../worker/lib/plan";

const NOW = Math.floor(Date.parse("2026-11-08T12:00:00Z") / 1000);
const FUTURE = NOW + 10 * 86_400;
const PAST = NOW - 10 * 86_400;
const PRODUCTS = ["prod_monthly", "prod_annual"];

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

describe("entitledProductIds", () => {
  it("keeps only the two configured Pro products", () => {
    expect(
      entitledProductIds({
        CREEM_PRODUCT_PRO_MONTHLY: "prod_monthly",
        CREEM_PRODUCT_PRO_ANNUAL: "prod_annual",
      }),
    ).toEqual(["prod_monthly", "prod_annual"]);
  });

  it("discards blank and placeholder product ids (fails closed)", () => {
    expect(
      entitledProductIds({
        CREEM_PRODUCT_PRO_MONTHLY: "",
        CREEM_PRODUCT_PRO_ANNUAL: "prod_REPLACE_ANNUAL",
      }),
    ).toEqual([]);
  });
});

describe("isEntitled", () => {
  it("grants Pro for active and trialing subscriptions", () => {
    expect(
      isEntitled(subscription({ status: "active" }), NOW, PRODUCTS),
    ).toBe(true);
    expect(
      isEntitled(subscription({ status: "trialing" }), NOW, PRODUCTS),
    ).toBe(true);
  });

  it("grants Pro for canceled/scheduled_cancel before period end", () => {
    expect(
      isEntitled(
        subscription({ status: "canceled", current_period_end: FUTURE }),
        NOW,
        PRODUCTS,
      ),
    ).toBe(true);
    expect(
      isEntitled(
        subscription({
          status: "scheduled_cancel",
          current_period_end: FUTURE,
        }),
        NOW,
        PRODUCTS,
      ),
    ).toBe(true);
  });

  it("does not grant Pro after the period ends", () => {
    expect(
      isEntitled(
        subscription({ status: "canceled", current_period_end: PAST }),
        NOW,
        PRODUCTS,
      ),
    ).toBe(false);
    expect(
      isEntitled(
        subscription({ status: "canceled", current_period_end: null }),
        NOW,
        PRODUCTS,
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
      "revoked",
    ]) {
      expect(
        isEntitled(
          subscription({ status, current_period_end: PAST }),
          NOW,
          PRODUCTS,
        ),
      ).toBe(false);
    }
  });

  it("never grants Pro for a product outside the allowlist", () => {
    for (const productId of ["prod_other", "prod_free", null]) {
      expect(
        isEntitled(
          subscription({ product_id: productId, status: "active" }),
          NOW,
          PRODUCTS,
        ),
      ).toBe(false);
    }
  });

  it("fails closed when no Pro products are configured", () => {
    expect(
      isEntitled(subscription({ status: "active" }), NOW, []),
    ).toBe(false);
  });
});

describe("resolvePlan", () => {
  it("returns Starter with nulls when there are no subscriptions", () => {
    expect(resolvePlan([], NOW, PRODUCTS)).toEqual({
      plan: "starter",
      interval: null,
      status: null,
      cancel_at_period_end: false,
      current_period_end: null,
      subscription_id: null,
      trial_ends_at: null,
    });
  });

  it("returns Pro for an active monthly subscription", () => {
    const view = resolvePlan([subscription()], NOW, PRODUCTS);
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
      PRODUCTS,
    );
    expect(view.plan).toBe("pro");
    expect(view.subscription_id).toBe("sub_active");
    expect(view.interval).toBe("monthly");
  });

  it("reports cancel_at_period_end for a scheduled cancellation", () => {
    const view = resolvePlan(
      [
        subscription({
          status: "scheduled_cancel",
          cancel_at_period_end: 1,
        }),
      ],
      NOW,
      PRODUCTS,
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
      PRODUCTS,
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
        PRODUCTS,
      ).plan,
    ).toBe("starter");
    expect(
      resolvePlan(
        [subscription({ status: "past_due", current_period_end: FUTURE })],
        NOW,
        PRODUCTS,
      ).plan,
    ).toBe("starter");
  });

  it("returns Starter for an active subscription on another product", () => {
    const view = resolvePlan(
      [subscription({ product_id: "prod_other", status: "active" })],
      NOW,
      PRODUCTS,
    );
    expect(view.plan).toBe("starter");
    expect(view.status).toBe("active");
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
      PRODUCTS,
    );
    expect(view.plan).toBe("starter");
    expect(view.subscription_id).toBe("sub_new");
    expect(view.interval).toBe("annual");
  });

  it("prefers a terminal status on an updated_at tie", () => {
    const view = resolvePlan(
      [
        subscription({
          id: "sub_active",
          status: "active",
          product_id: "prod_other",
          updated_at: NOW,
        }),
        subscription({
          id: "sub_revoked",
          status: "revoked",
          product_id: "prod_other",
          updated_at: NOW,
        }),
      ],
      NOW,
      PRODUCTS,
    );
    expect(view.plan).toBe("starter");
    expect(view.subscription_id).toBe("sub_revoked");
  });

  it("normalises stored intervals", () => {
    const view = resolvePlan(
      [subscription({ interval: "annual" })],
      NOW,
      PRODUCTS,
    );
    expect(view.interval).toBe("annual");
    expect(
      resolvePlan(
        [subscription({ interval: "week" })],
        NOW,
        PRODUCTS,
      ).interval,
    ).toBeNull();
  });
});

describe("resolvePlan — 14-day no-card trial", () => {
  const STARTED = NOW - 3 * 86_400;
  const TRIAL = { startedAt: STARTED, freeBlocked: false };

  it("resolves as Pro with only trial_ends_at set", () => {
    const view = resolvePlan([], NOW, PRODUCTS, TRIAL);
    expect(view).toEqual({
      plan: "pro",
      interval: null,
      status: null,
      cancel_at_period_end: false,
      current_period_end: null,
      subscription_id: null,
      trial_ends_at: STARTED + TRIAL_SECONDS,
    });
  });

  it("ends exactly at the 14-day boundary", () => {
    expect(resolvePlan([], STARTED + TRIAL_SECONDS - 1, PRODUCTS, TRIAL).plan).toBe(
      "pro",
    );
    expect(
      resolvePlan([], STARTED + TRIAL_SECONDS, PRODUCTS, TRIAL),
    ).toMatchObject({ plan: "starter", trial_ends_at: null });
  });

  it("a paid subscription takes precedence over the trial", () => {
    const view = resolvePlan([subscription()], NOW, PRODUCTS, TRIAL);
    expect(view.plan).toBe("pro");
    expect(view.interval).toBe("monthly");
    expect(view.status).toBe("active");
    expect(view.trial_ends_at).toBeNull();
  });

  it("any subscription row, even a dead one, suppresses the trial", () => {
    const view = resolvePlan(
      [
        subscription({
          status: "expired",
          current_period_end: PAST,
        }),
      ],
      NOW,
      PRODUCTS,
      TRIAL,
    );
    expect(view.plan).toBe("starter");
    expect(view.trial_ends_at).toBeNull();
  });

  it("a free-blocked account gets no trial even inside 14 days", () => {
    const view = resolvePlan([], NOW, PRODUCTS, {
      startedAt: STARTED,
      freeBlocked: true,
    });
    expect(view.plan).toBe("starter");
    expect(view.trial_ends_at).toBeNull();
  });

  it("a never-started trial stays Starter", () => {
    expect(
      resolvePlan([], NOW, PRODUCTS, { startedAt: null, freeBlocked: false })
        .plan,
    ).toBe("starter");
  });
});

describe("proEndedThisWeek", () => {
  const WEEK_START = NOW - 3 * 86_400;
  const NO_TRIAL = { startedAt: null, freeBlocked: false };

  it("is true for a trial that ended earlier this week", () => {
    const trial = { startedAt: NOW - TRIAL_SECONDS - 60, freeBlocked: false };
    const plan = resolvePlan([], NOW, PRODUCTS, trial);
    expect(
      proEndedThisWeek(plan, [], trial, PRODUCTS, NOW, WEEK_START),
    ).toBe(true);
  });

  it("is true for a paid period that ended this week", () => {
    const cancelled = subscription({
      status: "canceled",
      current_period_end: NOW - 60,
    });
    const plan = resolvePlan([cancelled], NOW, PRODUCTS);
    expect(
      proEndedThisWeek(
        plan,
        [cancelled],
        NO_TRIAL,
        PRODUCTS,
        NOW,
        WEEK_START,
      ),
    ).toBe(true);
  });

  it("is true when a refund revoked a paid subscription this week", () => {
    const revoked = subscription({
      status: "revoked",
      current_period_end: FUTURE,
      updated_at: (NOW - 60) * 1000,
    });
    const plan = resolvePlan([revoked], NOW, PRODUCTS);
    expect(
      proEndedThisWeek(
        plan,
        [revoked],
        NO_TRIAL,
        PRODUCTS,
        NOW,
        WEEK_START,
      ),
    ).toBe(true);
  });

  it("is false when Pro ended before this week or is still active", () => {
    const expired = subscription({
      status: "expired",
      current_period_end: PAST,
    });
    expect(
      proEndedThisWeek(
        resolvePlan([expired], NOW, PRODUCTS),
        [expired],
        NO_TRIAL,
        PRODUCTS,
        NOW,
        WEEK_START,
      ),
    ).toBe(false);
    const active = subscription();
    expect(
      proEndedThisWeek(
        resolvePlan([active], NOW, PRODUCTS),
        [active],
        NO_TRIAL,
        PRODUCTS,
        NOW,
        WEEK_START,
      ),
    ).toBe(false);
  });
});

describe("resolveBillingIssue", () => {
  it("reports past_due, unpaid and paused for a Starter account", () => {
    for (const status of ["past_due", "unpaid", "paused"]) {
      const view = resolvePlan(
        [subscription({ status })],
        NOW,
        PRODUCTS,
      );
      expect(view.plan).toBe("starter");
      expect(resolveBillingIssue(view)).toBe(status);
    }
  });

  it("returns null for entitled Pro and other Starter states", () => {
    expect(
      resolveBillingIssue(resolvePlan([subscription()], NOW, PRODUCTS)),
    ).toBeNull();
    for (const status of ["expired", "revoked", "canceled"]) {
      expect(
        resolveBillingIssue(
          resolvePlan(
            [
              subscription({
                status,
                current_period_end: PAST,
              }),
            ],
            NOW,
            PRODUCTS,
          ),
        ),
      ).toBeNull();
    }
  });
});

describe("terminalStatusRank", () => {
  it("ranks revoked above expired above unpaid above everything else", () => {
    expect(terminalStatusRank("revoked")).toBeGreaterThan(
      terminalStatusRank("expired"),
    );
    expect(terminalStatusRank("expired")).toBeGreaterThan(
      terminalStatusRank("unpaid"),
    );
    expect(terminalStatusRank("unpaid")).toBeGreaterThan(
      terminalStatusRank("active"),
    );
    expect(terminalStatusRank(null)).toBe(0);
    expect(terminalStatusRank(undefined)).toBe(0);
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
