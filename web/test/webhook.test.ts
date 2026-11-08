import { describe, expect, it } from "vitest";
import {
  parseCreemWebhook,
  shouldApplyUpdate,
  toUnixMillis,
  toUnixSeconds,
} from "../worker/lib/creem";

const UPDATED_AT_MS = Date.parse("2026-11-08T12:00:00.000Z");
const UPDATED_AT_SECONDS = Math.floor(UPDATED_AT_MS / 1000);

function subscriptionEvent(
  eventType: string,
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    id: "evt_1",
    eventType,
    created_at: UPDATED_AT_MS,
    object: {
      object: "subscription",
      id: "sub_1",
      status: "active",
      product: {
        id: "prod_monthly",
        recurring_interval: "month",
      },
      customer: {
        id: "cust_1",
        email: "a@b.com",
      },
      metadata: { user_id: "user_1" },
      current_period_end_date: "2026-12-08T12:00:00.000Z",
      updated_at: UPDATED_AT_MS,
      ...overrides,
    },
  };
}

describe("toUnixSeconds", () => {
  it("parses ISO strings to unix seconds", () => {
    expect(toUnixSeconds("2026-11-08T12:00:00.000Z")).toBe(
      UPDATED_AT_SECONDS,
    );
  });

  it("parses epoch milliseconds and seconds", () => {
    expect(toUnixSeconds(UPDATED_AT_MS)).toBe(UPDATED_AT_SECONDS);
    expect(toUnixSeconds(UPDATED_AT_SECONDS)).toBe(UPDATED_AT_SECONDS);
    expect(toUnixSeconds(String(UPDATED_AT_MS))).toBe(UPDATED_AT_SECONDS);
  });

  it("returns null for garbage", () => {
    expect(toUnixSeconds("not a date")).toBeNull();
    expect(toUnixSeconds(null)).toBeNull();
    expect(toUnixSeconds(-5)).toBeNull();
    expect(toUnixSeconds(Number.NaN)).toBeNull();
  });

  it("keeps millisecond precision for event ordering", () => {
    expect(toUnixMillis(UPDATED_AT_MS + 500)).toBe(UPDATED_AT_MS + 500);
    // Two events in the same second are still orderable.
    expect(shouldApplyUpdate(UPDATED_AT_MS + 500, UPDATED_AT_MS)).toBe(false);
    expect(shouldApplyUpdate(UPDATED_AT_MS + 500, UPDATED_AT_MS + 600)).toBe(
      true,
    );
  });
});

describe("shouldApplyUpdate", () => {
  it("applies the first event and newer events", () => {
    expect(shouldApplyUpdate(null, 100)).toBe(true);
    expect(shouldApplyUpdate(100, 101)).toBe(true);
    expect(shouldApplyUpdate(100, 100)).toBe(true);
  });

  it("ignores older events (out-of-order delivery)", () => {
    expect(shouldApplyUpdate(200, 199)).toBe(false);
    expect(shouldApplyUpdate(200, 100)).toBe(false);
  });
});

describe("parseCreemWebhook — subscription events", () => {
  it("parses subscription.paid", () => {
    const parsed = parseCreemWebhook(subscriptionEvent("subscription.paid"));
    expect(parsed.kind).toBe("subscription");
    if (parsed.kind !== "subscription") throw new Error("unreachable");
    expect(parsed.subscription).toEqual({
      subscriptionId: "sub_1",
      status: "active",
      productId: "prod_monthly",
      interval: "monthly",
      customerId: "cust_1",
      customerEmail: "a@b.com",
      metadataUserId: "user_1",
      currentPeriodEnd: Math.floor(
        Date.parse("2026-12-08T12:00:00.000Z") / 1000,
      ),
      cancelAtPeriodEnd: false,
      eventTimestamp: UPDATED_AT_MS,
    });
  });

  it("maps scheduled_cancel to cancel_at_period_end and keeps Pro", () => {
    const parsed = parseCreemWebhook(
      subscriptionEvent("subscription.scheduled_cancel", {
        status: "scheduled_cancel",
      }),
    );
    if (parsed.kind !== "subscription") throw new Error("unreachable");
    expect(parsed.subscription.cancelAtPeriodEnd).toBe(true);
    expect(parsed.subscription.status).toBe("scheduled_cancel");
    expect(parsed.subscription.currentPeriodEnd).toBeGreaterThan(
      UPDATED_AT_SECONDS,
    );
  });

  it("normalises subscription.expired even when Creem repeats the old status", () => {
    const parsed = parseCreemWebhook(
      subscriptionEvent("subscription.expired", {
        status: "active",
        current_period_end_date: "2026-11-01T00:00:00.000Z",
      }),
    );
    if (parsed.kind !== "subscription") throw new Error("unreachable");
    expect(parsed.subscription.status).toBe("expired");
  });

  it("derives interval from the configured product id", () => {
    const parsed = parseCreemWebhook(
      subscriptionEvent("subscription.paid", {
        product: { id: "prod_annual" },
      }),
      { monthlyProductId: "prod_monthly", annualProductId: "prod_annual" },
    );
    if (parsed.kind !== "subscription") throw new Error("unreachable");
    expect(parsed.subscription.interval).toBe("annual");
  });

  it("accepts the SDK-style userId metadata key", () => {
    const parsed = parseCreemWebhook(
      subscriptionEvent("subscription.active", {
        metadata: { userId: "user_2" },
      }),
    );
    if (parsed.kind !== "subscription") throw new Error("unreachable");
    expect(parsed.subscription.metadataUserId).toBe("user_2");
  });

  it("falls back to the envelope timestamp when object timestamps are absent", () => {
    const event = subscriptionEvent("subscription.active") as {
      object: Record<string, unknown>;
    };
    delete event.object["updated_at"];
    delete event.object["created_at"];
    const parsed = parseCreemWebhook(event);
    if (parsed.kind !== "subscription") throw new Error("unreachable");
    expect(parsed.subscription.eventTimestamp).toBe(UPDATED_AT_MS);
  });

  it("ignores malformed subscription events", () => {
    expect(
      parseCreemWebhook({
        id: "evt_x",
        eventType: "subscription.paid",
        object: { status: "active" },
      }).kind,
    ).toBe("ignored");
    expect(
      parseCreemWebhook({
        id: "evt_x",
        eventType: "subscription.update",
        object: { id: "sub_1" },
      }).kind,
    ).toBe("ignored");
  });
});

describe("parseCreemWebhook — checkout.completed", () => {
  it("uses the nested subscription and checkout-level customer/product", () => {
    const parsed = parseCreemWebhook({
      id: "evt_checkout",
      eventType: "checkout.completed",
      created_at: UPDATED_AT_MS,
      object: {
        object: "checkout",
        id: "ch_1",
        metadata: { user_id: "user_checkout" },
        customer: { id: "cust_checkout", email: "checkout@b.com" },
        product: { id: "prod_annual", recurring_interval: "year" },
        subscription: {
          id: "sub_checkout",
          object: "subscription",
          status: "active",
          product: "prod_annual",
          customer: "cust_checkout",
          // Empty subscription metadata must not hide checkout metadata.
          metadata: {},
          current_period_end_date: "2027-11-08T12:00:00.000Z",
          updated_at: UPDATED_AT_MS,
        },
      },
    });
    if (parsed.kind !== "subscription") throw new Error("unreachable");
    expect(parsed.subscription.subscriptionId).toBe("sub_checkout");
    expect(parsed.subscription.customerId).toBe("cust_checkout");
    expect(parsed.subscription.customerEmail).toBe("checkout@b.com");
    expect(parsed.subscription.productId).toBe("prod_annual");
    expect(parsed.subscription.interval).toBe("annual");
    expect(parsed.subscription.metadataUserId).toBe("user_checkout");
    expect(parsed.subscription.status).toBe("active");
  });

  it("ignores checkouts that did not create a subscription", () => {
    const parsed = parseCreemWebhook({
      id: "evt_checkout",
      eventType: "checkout.completed",
      object: { id: "ch_1", subscription: null },
    });
    expect(parsed).toEqual({
      kind: "ignored",
      reason: "checkout_without_subscription",
    });
  });
});

describe("parseCreemWebhook — other events", () => {
  it("ignores refunds, disputes and credits", () => {
    for (const eventType of [
      "refund.created",
      "dispute.created",
      "credits.granted",
    ]) {
      const parsed = parseCreemWebhook({
        id: `evt_${eventType}`,
        eventType,
        object: { id: "obj_1" },
      });
      expect(parsed.kind).toBe("ignored");
    }
  });

  it("ignores envelopes that are not objects", () => {
    expect(parseCreemWebhook(null).kind).toBe("ignored");
    expect(parseCreemWebhook([]).kind).toBe("ignored");
  });
});
