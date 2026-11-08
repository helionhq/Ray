import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import app from "../../worker/index";
import type { Env } from "../../worker/env";
import {
  base64Decode,
  base64Encode,
  hmacSha256Bytes,
  hmacSha256Hex,
  randomToken,
  sha256Hex,
} from "../../worker/lib/crypto";
import { listSubscriptions, getUser, claimPendingCheckoutStatement } from "../../worker/db";
import { BATCH_MAX_BYTES } from "../../worker/routes/stt";
import { weekBounds, nowSeconds } from "../../worker/lib/weeks";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function seedUser(
  id: string,
  email: string | null = `${id}@example.com`,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, creem_customer_id, created_at)
     VALUES (?, ?, NULL, NULL, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(id, email, nowSeconds())
    .run();
}

async function seedDevice(userId: string): Promise<string> {
  const token = `ray_${randomToken()}`;
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare(
    `INSERT INTO devices (id, user_id, token_hash, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL, NULL)`,
  )
    .bind(`dev_${crypto.randomUUID()}`, userId, tokenHash, nowSeconds())
    .run();
  return token;
}

async function seedSubscription(
  userId: string,
  overrides: {
    id?: string;
    productId?: string;
    status?: string;
    currentPeriodEnd?: number | null;
    updatedAt?: number;
  } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO subscriptions
       (id, user_id, product_id, interval, status, current_period_end, cancel_at_period_end, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
  )
    .bind(
      overrides.id ?? `sub_${userId}`,
      userId,
      overrides.productId ?? "prod_test_monthly",
      "monthly",
      overrides.status ?? "active",
      overrides.currentPeriodEnd ?? nowSeconds() + 30 * 86_400,
      overrides.updatedAt ?? Date.now(),
    )
    .run();
}

type CreemFixture = {
  productId?: string;
  status?: string;
  eventType?: string;
  metadata?: Record<string, unknown> | null;
  customer?: { id: string; email?: string } | null;
  subscriptionId?: string;
  updatedAtMs?: number;
};

function creemSubscriptionEvent(fixture: CreemFixture = {}): unknown {
  const updatedAtMs = fixture.updatedAtMs ?? Date.now();
  return {
    id: `evt_${crypto.randomUUID()}`,
    eventType: fixture.eventType ?? "subscription.paid",
    created_at: updatedAtMs,
    object: {
      object: "subscription",
      id: fixture.subscriptionId ?? "sub_wh",
      status: fixture.status ?? "active",
      product: {
        id: fixture.productId ?? "prod_test_monthly",
        recurring_interval: "month",
      },
      customer: fixture.customer ?? {
        id: "cust_wh",
        email: "wh@example.com",
      },
      ...(fixture.metadata === null
        ? {}
        : { metadata: fixture.metadata ?? { user_id: "user_wh" } }),
      current_period_end_date: new Date(
        Date.now() + 30 * 86_400_000,
      ).toISOString(),
      updated_at: updatedAtMs,
    },
  };
}

function creemRevocationEvent(
  eventType: "refund.created" | "dispute.created",
  fixture: {
    subscriptionId?: string;
    productId?: string;
    customerId?: string;
    email?: string;
    metadata?: Record<string, unknown> | null;
    updatedAtMs?: number;
  } = {},
): unknown {
  const updatedAtMs = fixture.updatedAtMs ?? Date.now();
  return {
    id: `evt_${crypto.randomUUID()}`,
    eventType,
    created_at: updatedAtMs,
    object: {
      id: eventType === "refund.created" ? "ref_1" : "disp_1",
      object: eventType === "refund.created" ? "refund" : "dispute",
      status: "succeeded",
      transaction: {
        id: "tran_1",
        subscription: fixture.subscriptionId ?? "sub_wh",
        customer: fixture.customerId ?? "cust_wh",
      },
      subscription: {
        id: fixture.subscriptionId ?? "sub_wh",
        object: "subscription",
        product: fixture.productId ?? "prod_test_monthly",
        customer: fixture.customerId ?? "cust_wh",
        status: "active",
        current_period_end_date: new Date(
          Date.now() + 30 * 86_400_000,
        ).toISOString(),
        updated_at: updatedAtMs,
        ...(fixture.metadata === null
          ? {}
          : { metadata: fixture.metadata ?? { user_id: "user_wh" } }),
      },
      checkout: {
        id: "ch_1",
        product: fixture.productId ?? "prod_test_monthly",
        ...(fixture.metadata === null
          ? {}
          : { metadata: fixture.metadata ?? { user_id: "user_wh" } }),
      },
      customer: {
        id: fixture.customerId ?? "cust_wh",
        email: fixture.email ?? "wh@example.com",
      },
      created_at: updatedAtMs,
    },
  };
}

async function deliverCreem(event: unknown): Promise<Response> {
  const body = JSON.stringify(event);
  const signature = await hmacSha256Hex(
    String(env.CREEM_WEBHOOK_SECRET),
    body,
  );
  return SELF.fetch("https://ray.test/api/webhooks/creem", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "creem-signature": signature,
    },
    body,
  });
}

/** A full Env for `app.request` with per-test overrides. */
function workerEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: env.DB,
    SITE_URL: env.SITE_URL,
    CLERK_PUBLISHABLE_KEY: env.CLERK_PUBLISHABLE_KEY,
    CREEM_API_BASE: env.CREEM_API_BASE,
    CREEM_PRODUCT_PRO_MONTHLY: env.CREEM_PRODUCT_PRO_MONTHLY,
    CREEM_PRODUCT_PRO_ANNUAL: env.CREEM_PRODUCT_PRO_ANNUAL,
    STARTER_WEEKLY_WORDS: env.STARTER_WEEKLY_WORDS,
    FAIR_USE_WEEKLY_WORDS: env.FAIR_USE_WEEKLY_WORDS,
    CLEANUP_MODELS: env.CLEANUP_MODELS,
    CLERK_SECRET_KEY: env.CLERK_SECRET_KEY,
    ASSEMBLYAI_API_KEY: env.ASSEMBLYAI_API_KEY,
    CREEM_API_KEY: env.CREEM_API_KEY,
    CREEM_WEBHOOK_SECRET: env.CREEM_WEBHOOK_SECRET,
    CLERK_WEBHOOK_SECRET: env.CLERK_WEBHOOK_SECRET,
    ...overrides,
  };
}

async function deliverClerk(
  event: unknown,
  options: {
    secret?: string;
    id?: string;
    timestamp?: number;
    environment?: Env;
  } = {},
): Promise<Response> {
  const body = JSON.stringify(event);
  const id = options.id ?? `msg_${crypto.randomUUID()}`;
  const timestamp = String(options.timestamp ?? nowSeconds());
  const secret = options.secret ?? String(env.CLERK_WEBHOOK_SECRET);
  const key = base64Decode(secret.replace(/^whsec_/u, ""));
  if (!key) throw new Error("test secret is not valid base64");
  const signature = base64Encode(
    await hmacSha256Bytes(key, `${id}.${timestamp}.${body}`),
  );
  const request = new Request("https://ray.test/api/webhooks/clerk", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    },
    body,
  });
  return options.environment
    ? app.request(request, undefined, options.environment)
    : SELF.fetch(request);
}

function userDeletedEvent(userId: string): unknown {
  return {
    object: "event",
    type: "user.deleted",
    timestamp: Date.now(),
    instance_id: "ins_test",
    data: { object: "user", id: userId, deleted: true },
  };
}

// ---------------------------------------------------------------------------
// Billing integrity
// ---------------------------------------------------------------------------

describe("billing integrity — product gating", () => {
  it("does not grant Pro for a product outside the allowlist", async () => {
    await seedUser("user_other_product");
    const token = await seedDevice("user_other_product");

    const response = await deliverCreem(
      creemSubscriptionEvent({
        productId: "prod_other",
        metadata: { user_id: "user_other_product" },
        customer: { id: "cust_other" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toMatchObject({
      applied: false,
      ignored: "product_not_allowed",
    });
    expect(
      await listSubscriptions(env.DB, "user_other_product"),
    ).toHaveLength(0);

    const me = await SELF.fetch("https://ray.test/api/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect((await jsonOf(me))["plan"]).toBe("starter");
  });

  it("grants Pro for an allowlisted product", async () => {
    await seedUser("user_allowed_product");
    const token = await seedDevice("user_allowed_product");
    const response = await deliverCreem(
      creemSubscriptionEvent({
        metadata: { user_id: "user_allowed_product" },
        customer: { id: "cust_allowed" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toMatchObject({ applied: true });

    const me = await SELF.fetch("https://ray.test/api/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect((await jsonOf(me))["plan"]).toBe("pro");
  });
});

describe("billing integrity — one checkout at a time", () => {
  it("claims the checkout slot until its TTL expires", async () => {
    const userId = "user_pending_ttl";
    const now = nowSeconds();
    const first = await claimPendingCheckoutStatement(
      env.DB,
      userId,
      now,
      900,
    ).run();
    expect(first.meta.changes).toBe(1);

    // A second checkout while the first is still waiting for its webhook.
    const duplicate = await claimPendingCheckoutStatement(
      env.DB,
      userId,
      now + 10,
      900,
    ).run();
    expect(duplicate.meta.changes).toBe(0);

    // An abandoned checkout stops blocking after the TTL.
    const expired = await claimPendingCheckoutStatement(
      env.DB,
      userId,
      now + 901,
      900,
    ).run();
    expect(expired.meta.changes).toBe(1);
  });

  it("answers 409 checkout_pending instead of creating a second checkout", async () => {
    const userId = "user_pending_checkout";
    await seedUser(userId);
    const token = await seedDevice(userId);
    await env.DB.prepare(
      "INSERT INTO pending_checkouts (user_id, created_at) VALUES (?, ?)",
    )
      .bind(userId, nowSeconds())
      .run();

    // No Creem request is made: the guard runs before the upstream call.
    const response = await SELF.fetch(
      "https://ray.test/api/billing/checkout",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ interval: "monthly" }),
      },
    );
    expect(response.status).toBe(409);
    expect(await jsonOf(response)).toMatchObject({ error: "checkout_pending" });
  });

  it("clears the pending checkout when the subscription webhook lands", async () => {
    const userId = "user_pending_cleared";
    await seedUser(userId);
    await env.DB.prepare(
      "INSERT INTO pending_checkouts (user_id, created_at) VALUES (?, ?)",
    )
      .bind(userId, nowSeconds())
      .run();

    const response = await deliverCreem(
      creemSubscriptionEvent({
        metadata: { user_id: userId },
        customer: { id: `cust_${userId}` },
        subscriptionId: `sub_${userId}`,
      }),
    );
    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toMatchObject({ applied: true });
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM pending_checkouts WHERE user_id = ?",
    )
      .bind(userId)
      .first<{ count: number }>();
    expect(row?.count).toBe(0);
  });
});

describe("billing integrity — refunds and disputes revoke Pro", () => {
  for (const eventType of ["refund.created", "dispute.created"] as const) {
    it(`${eventType} revokes entitlement immediately`, async () => {
      const userId = `user_${eventType.replace(/\W/gu, "_")}`;
      await seedUser(userId);
      const token = await seedDevice(userId);

      await deliverCreem(
        creemSubscriptionEvent({
          metadata: { user_id: userId },
          customer: { id: `cust_${userId}` },
          subscriptionId: `sub_${userId}`,
        }),
      );
      expect(
        (
          await jsonOf(
            await SELF.fetch("https://ray.test/api/me", {
              headers: { authorization: `Bearer ${token}` },
            }),
          )
        )["plan"],
      ).toBe("pro");

      const revoke = await deliverCreem(
        creemRevocationEvent(eventType, {
          subscriptionId: `sub_${userId}`,
          customerId: `cust_${userId}`,
          metadata: { user_id: userId },
          updatedAtMs: Date.now() + 1_000,
        }),
      );
      expect(revoke.status).toBe(200);
      expect(await jsonOf(revoke)).toMatchObject({ applied: true });

      const subscriptions = await listSubscriptions(env.DB, userId);
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0]?.status).toBe("revoked");

      const me = await jsonOf(
        await SELF.fetch("https://ray.test/api/me", {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(me["plan"]).toBe("starter");
      expect(me["status"]).toBe("revoked");
      expect(me["billing_issue"]).toBeNull();
    });
  }

  it("an equal-timestamp active event cannot overwrite a refund", async () => {
    const userId = "user_terminal_tie";
    await seedUser(userId);
    const token = await seedDevice(userId);
    const timestamp = Date.now();

    await deliverCreem(
      creemSubscriptionEvent({
        metadata: { user_id: userId },
        customer: { id: "cust_tie" },
        subscriptionId: "sub_tie",
        updatedAtMs: timestamp,
      }),
    );
    await deliverCreem(
      creemRevocationEvent("refund.created", {
        subscriptionId: "sub_tie",
        customerId: "cust_tie",
        metadata: { user_id: userId },
        updatedAtMs: timestamp,
      }),
    );
    expect(
      (await listSubscriptions(env.DB, userId))[0]?.status,
    ).toBe("revoked");

    // A later delivery of an active event with the SAME timestamp loses.
    await deliverCreem(
      creemSubscriptionEvent({
        metadata: { user_id: userId },
        customer: { id: "cust_tie" },
        subscriptionId: "sub_tie",
        updatedAtMs: timestamp,
      }),
    );
    expect(
      (await listSubscriptions(env.DB, userId))[0]?.status,
    ).toBe("revoked");
    const me = await jsonOf(
      await SELF.fetch("https://ray.test/api/me", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(me["plan"]).toBe("starter");
  });
});

describe("billing integrity — user mapping and secrets", () => {
  it("never maps a webhook user by email", async () => {
    await seedUser("user_email_only", "email-only@example.com");
    const response = await deliverCreem(
      creemSubscriptionEvent({
        metadata: null,
        customer: { id: "cust_never_seen", email: "email-only@example.com" },
        subscriptionId: "sub_email_only",
      }),
    );
    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toMatchObject({
      applied: false,
      ignored: "user_not_found",
    });
    expect(
      await listSubscriptions(env.DB, "user_email_only"),
    ).toHaveLength(0);
  });

  it("maps by metadata.user_id and stores the Creem customer id", async () => {
    await seedUser("user_metadata_map");
    const response = await deliverCreem(
      creemSubscriptionEvent({
        metadata: { user_id: "user_metadata_map" },
        customer: { id: "cust_metadata_map" },
        subscriptionId: "sub_metadata_map",
      }),
    );
    expect(await jsonOf(response)).toMatchObject({ applied: true });
    const row = await env.DB.prepare(
      "SELECT creem_customer_id FROM users WHERE id = ?",
    )
      .bind("user_metadata_map")
      .first<{ creem_customer_id: string }>();
    expect(row?.creem_customer_id).toBe("cust_metadata_map");
  });

  it("fails closed when CREEM_WEBHOOK_SECRET is missing", async () => {
    await seedUser("user_no_secret");
    const body = JSON.stringify(
      creemSubscriptionEvent({
        metadata: { user_id: "user_no_secret" },
      }),
    );
    const signature = await hmacSha256Hex(
      String(env.CREEM_WEBHOOK_SECRET),
      body,
    );
    const response = await app.request(
      new Request("https://ray.test/api/webhooks/creem", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "creem-signature": signature,
        },
        body,
      }),
      undefined,
      workerEnv({ CREEM_WEBHOOK_SECRET: "" }),
    );
    expect(response.status).toBe(401);
    expect(await jsonOf(response)).toMatchObject({
      error: "unauthorized",
    });
    expect(await listSubscriptions(env.DB, "user_no_secret")).toHaveLength(0);
  });
});

describe("billing integrity — idempotency after apply", () => {
  it("rolls back state when the marker write fails, then applies on retry", async () => {
    await seedUser("user_retry");
    const event = creemSubscriptionEvent({
      metadata: { user_id: "user_retry" },
      customer: { id: "cust_retry" },
      subscriptionId: "sub_retry",
    });
    const eventId = (event as { id: string }).id;

    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS test_webhook_failures (id TEXT PRIMARY KEY)`,
    ).run();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO test_webhook_failures (id) VALUES (?)`,
    )
      .bind(eventId)
      .run();
    await env.DB.prepare(
      `DROP TRIGGER IF EXISTS test_fail_webhook_insert`,
    ).run();
    await env.DB.prepare(
      `CREATE TRIGGER test_fail_webhook_insert
       BEFORE INSERT ON webhook_events
       WHEN NEW.id IN (SELECT id FROM test_webhook_failures)
       BEGIN
         SELECT RAISE(ABORT, 'simulated failure');
       END`,
    ).run();

    try {
      const failed = await deliverCreem(event);
      expect(failed.status).toBe(500);
      // The whole batch rolled back: no state, no idempotency marker.
      expect(await listSubscriptions(env.DB, "user_retry")).toHaveLength(0);
      const marker = await env.DB.prepare(
        "SELECT id FROM webhook_events WHERE id = ?",
      )
        .bind(eventId)
        .first();
      expect(marker).toBeNull();

      // Creem's retry now succeeds and applies the state exactly once.
      await env.DB.prepare(
        `DELETE FROM test_webhook_failures WHERE id = ?`,
      )
        .bind(eventId)
        .run();

      const retried = await deliverCreem(event);
      expect(retried.status).toBe(200);
      expect(await jsonOf(retried)).toMatchObject({ applied: true });
      expect(await listSubscriptions(env.DB, "user_retry")).toHaveLength(1);

      const duplicate = await deliverCreem(event);
      expect(await jsonOf(duplicate)).toMatchObject({ duplicate: true });
      expect(await listSubscriptions(env.DB, "user_retry")).toHaveLength(1);
    } finally {
      await env.DB.prepare(
        "DROP TRIGGER IF EXISTS test_fail_webhook_insert",
      ).run();
      await env.DB.prepare(
        "DROP TABLE IF EXISTS test_webhook_failures",
      ).run();
    }
  });
});

// ---------------------------------------------------------------------------
// /api/me additions and checkout billing guard
// ---------------------------------------------------------------------------

describe("/api/me and checkout billing issue", () => {
  it("never returns a null email and reports billing_issue", async () => {
    await seedUser("user_billing_issue", null);
    const token = await seedDevice("user_billing_issue");
    await seedSubscription("user_billing_issue", {
      id: "sub_billing_issue",
      status: "past_due",
      currentPeriodEnd: nowSeconds() + 30 * 86_400,
    });

    const me = await jsonOf(
      await SELF.fetch("https://ray.test/api/me", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect((me["user"] as Record<string, unknown>)["email"]).toBe("");
    expect(me["plan"]).toBe("starter");
    expect(me["billing_issue"]).toBe("past_due");

    const checkout = await SELF.fetch(
      "https://ray.test/api/billing/checkout",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ interval: "monthly" }),
      },
    );
    expect(checkout.status).toBe(409);
    expect(await jsonOf(checkout)).toMatchObject({
      error: "billing_issue",
    });
  });

  it("returns billing_issue null for a healthy Starter account", async () => {
    await seedUser("user_no_billing_issue");
    const token = await seedDevice("user_no_billing_issue");
    const me = await jsonOf(
      await SELF.fetch("https://ray.test/api/me", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect((me["user"] as Record<string, unknown>)["email"]).toBe(
      "user_no_billing_issue@example.com",
    );
    expect(me["billing_issue"]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Clerk user.deleted webhook
// ---------------------------------------------------------------------------

describe("Clerk user.deleted webhook", () => {
  it("revokes devices and soft-deletes the user", async () => {
    const userId = "user_clerk_deleted";
    await seedUser(userId);
    const token = await seedDevice(userId);
    await seedDevice(userId);

    const before = await SELF.fetch("https://ray.test/api/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.status).toBe(200);

    const response = await deliverClerk(userDeletedEvent(userId), {
      id: "msg_delete_1",
    });
    expect(response.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT deleted_at FROM users WHERE id = ?",
    )
      .bind(userId)
      .first<{ deleted_at: number | null }>();
    expect(row?.deleted_at).not.toBeNull();
    expect(await getUser(env.DB, userId)).toBeNull();

    const devices = await env.DB.prepare(
      "SELECT revoked_at FROM devices WHERE user_id = ?",
    )
      .bind(userId)
      .all<{ revoked_at: number | null }>();
    expect(devices.results?.every((device) => device.revoked_at !== null)).toBe(
      true,
    );

    const after = await SELF.fetch("https://ray.test/api/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.status).toBe(401);

    const duplicate = await deliverClerk(userDeletedEvent(userId), {
      id: "msg_delete_1",
    });
    expect(await jsonOf(duplicate)).toMatchObject({ duplicate: true });
  });

  it("rejects an invalid Svix signature and stale timestamps", async () => {
    const userId = "user_clerk_bad_signature";
    await seedUser(userId);

    const invalid = await deliverClerk(userDeletedEvent(userId), {
      secret: "whsec_b3RoZXJfc2VjcmV0",
    });
    expect(invalid.status).toBe(401);

    const stale = await deliverClerk(userDeletedEvent(userId), {
      timestamp: nowSeconds() - 3_600,
    });
    expect(stale.status).toBe(401);

    expect(await getUser(env.DB, userId)).not.toBeNull();
  });

  it("ignores other Clerk event types", async () => {
    const response = await deliverClerk({
      object: "event",
      type: "user.created",
      timestamp: Date.now(),
      instance_id: "ins_test",
      data: { id: "user_ignored" },
    });
    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toMatchObject({
      received: true,
      ignored: "unhandled_event:user.created",
    });
  });

  it("is disabled when CLERK_WEBHOOK_SECRET is unset", async () => {
    const response = await deliverClerk(userDeletedEvent("user_unset"), {
      environment: workerEnv({ CLERK_WEBHOOK_SECRET: "" }),
    });
    expect(response.status).toBe(503);
    expect(await jsonOf(response)).toMatchObject({
      error: "not_configured",
    });
  });
});

// ---------------------------------------------------------------------------
// STT guards and batch input cap
// ---------------------------------------------------------------------------

describe("STT concurrency lease and failure budget", () => {
  it("rejects a third concurrent STT request with too_many_requests", async () => {
    await seedUser("user_lease_http");
    const token = await seedDevice("user_lease_http");
    const now = nowSeconds();
    for (const id of ["lease_http_1", "lease_http_2"]) {
      await env.DB.prepare(
        "INSERT INTO stt_leases (id, user_id, expires_at) VALUES (?, ?, ?)",
      )
        .bind(id, "user_lease_http", now + 300)
        .run();
    }

    const response = await SELF.fetch("https://ray.test/v1/stt/batch", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "audio/wav",
      },
      body: "audio",
    });
    expect(response.status).toBe(429);
    expect(await jsonOf(response)).toMatchObject({
      error: "too_many_requests",
    });
  });

  it("releases its lease when the handler returns an error", async () => {
    await seedUser("user_lease_release");
    const token = await seedDevice("user_lease_release");

    const response = await SELF.fetch("https://ray.test/v1/stt/batch", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "audio/wav",
        "x-ray-keyterms": "!!!not-base64!!!",
      },
      body: "audio",
    });
    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toMatchObject({
      error: "invalid_keyterms",
    });
    const leases = await env.DB.prepare(
      "SELECT id FROM stt_leases WHERE user_id = ?",
    )
      .bind("user_lease_release")
      .all();
    expect(leases.results).toHaveLength(0);
  });

  it("rejects STT once the weekly failure budget is exhausted", async () => {
    await seedUser("user_failure_budget");
    const token = await seedDevice("user_failure_budget");
    const weekStart = weekBounds(nowSeconds()).weekStart;
    await env.DB.prepare(
      "INSERT INTO stt_failures (user_id, week_start, failures) VALUES (?, ?, 200)",
    )
      .bind("user_failure_budget", weekStart)
      .run();

    const response = await SELF.fetch("https://ray.test/v1/stt/batch", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "audio/wav",
      },
      body: "audio",
    });
    expect(response.status).toBe(429);
    const body = await jsonOf(response);
    expect(body["error"]).toBe("too_many_requests");
    expect(typeof body["resets_at"]).toBe("string");
  });

  it("rejects a batch body whose Content-Length exceeds the cap", async () => {
    await seedUser("user_batch_length");
    const token = await seedDevice("user_batch_length");

    const request = new Request("https://ray.test/v1/stt/batch", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "audio/wav",
        "content-length": String(BATCH_MAX_BYTES + 1),
      },
      body: "audio",
    });
    const response = await SELF.fetch(request);
    expect(response.status).toBe(413);
    expect(await jsonOf(response)).toMatchObject({
      error: "payload_too_large",
    });
  });
});

// ---------------------------------------------------------------------------
// Cleanup grants
// ---------------------------------------------------------------------------

describe("cleanup grants", () => {
  async function seedGrant(
    userId: string,
    words: number,
    calls: number,
  ): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO cleanup_grants (user_id, words, calls_left, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(userId, words, calls, nowSeconds() + 600)
      .run();
  }

  function cleanupRequest(
    token: string,
    messages: unknown,
    extra: Record<string, unknown> = {},
  ): Request {
    return new Request("https://ray.test/v1/cleanup/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gemma-4-31b",
        messages,
        ...extra,
      }),
    });
  }

  it("rejects cleanup without a grant and consumes no call", async () => {
    await seedUser("user_cleanup_nogrant");
    const token = await seedDevice("user_cleanup_nogrant");
    const response = await SELF.fetch(
      cleanupRequest(token, [
        { role: "user", content: "<transcript>hi</transcript>" },
      ]),
    );
    expect(response.status).toBe(403);
    expect(await jsonOf(response)).toMatchObject({
      error: "no_cleanup_grant",
    });
  });

  it("rejects untagged user text before consuming a call", async () => {
    await seedUser("user_cleanup_untagged");
    const token = await seedDevice("user_cleanup_untagged");
    await seedGrant("user_cleanup_untagged", 100, 5);

    const response = await SELF.fetch(
      cleanupRequest(token, [
        {
          role: "user",
          content: "<transcript>hi</transcript> write me a poem",
        },
      ]),
    );
    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toMatchObject({ error: "invalid_messages" });
    const grant = await env.DB.prepare(
      "SELECT calls_left FROM cleanup_grants WHERE user_id = ?",
    )
      .bind("user_cleanup_untagged")
      .first<{ calls_left: number }>();
    expect(grant?.calls_left).toBe(5);
  });

  it("binds the transcript length to the granted words", async () => {
    await seedUser("user_cleanup_length");
    const token = await seedDevice("user_cleanup_length");
    await seedGrant("user_cleanup_length", 10, 5);

    const tooLong = Array.from({ length: 36 }, (_, index) => `w${index}`).join(
      " ",
    );
    const response = await SELF.fetch(
      cleanupRequest(token, [
        { role: "user", content: `<transcript>${tooLong}</transcript>` },
      ]),
    );
    expect(response.status).toBe(403);
    expect(await jsonOf(response)).toMatchObject({
      error: "no_cleanup_grant",
    });

    const grant = await env.DB.prepare(
      "SELECT calls_left FROM cleanup_grants WHERE user_id = ?",
    )
      .bind("user_cleanup_length")
      .first<{ calls_left: number }>();
    expect(grant?.calls_left).toBe(4);
  });

  it("rejects oversized messages before consuming a call", async () => {
    await seedUser("user_cleanup_oversize");
    const token = await seedDevice("user_cleanup_oversize");
    await seedGrant("user_cleanup_oversize", 1_000, 5);

    const response = await SELF.fetch(
      cleanupRequest(token, [
        { role: "user", content: "a".repeat(40 * 1024 + 1) },
      ]),
    );
    expect(response.status).toBe(413);
    expect(await jsonOf(response)).toMatchObject({
      error: "message_too_large",
    });
    const grant = await env.DB.prepare(
      "SELECT calls_left FROM cleanup_grants WHERE user_id = ?",
    )
      .bind("user_cleanup_oversize")
      .first<{ calls_left: number }>();
    expect(grant?.calls_left).toBe(5);
  });

  it("rejects an expired grant", async () => {
    await seedUser("user_cleanup_expired");
    const token = await seedDevice("user_cleanup_expired");
    await env.DB.prepare(
      `INSERT INTO cleanup_grants (user_id, words, calls_left, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
      .bind("user_cleanup_expired", 100, 5, nowSeconds() - 1)
      .run();

    const response = await SELF.fetch(
      cleanupRequest(token, [
        { role: "user", content: "<transcript>hi</transcript>" },
      ]),
    );
    expect(response.status).toBe(403);
    expect(await jsonOf(response)).toMatchObject({
      error: "no_cleanup_grant",
    });
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("rate limiting", () => {
  it("returns 429 too_many_requests when the binding denies", async () => {
    let keySeen = "";
    const response = await app.request(
      new Request("https://ray.test/api/desktop/token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.9",
        },
        body: "{}",
      }),
      undefined,
      workerEnv({
        RATE_LIMIT_DESKTOP_TOKEN: {
          limit: async ({ key }) => {
            keySeen = key;
            return { success: false };
          },
        },
      }),
    );
    expect(response.status).toBe(429);
    expect(await jsonOf(response)).toMatchObject({
      error: "too_many_requests",
    });
    expect(keySeen).toBe("ip:203.0.113.9");
  });

  it("continues when the binding is absent", async () => {
    const response = await app.request(
      new Request("https://ray.test/api/desktop/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      undefined,
      workerEnv({ RATE_LIMIT_DESKTOP_TOKEN: undefined }),
    );
    // The handler itself answers 400 for an empty body; the limiter did not
    // block the request.
    expect(response.status).toBe(400);
  });
});
