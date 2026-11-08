import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  addWords,
  getUsageWords,
  listSubscriptions,
} from "../../worker/db";
import {
  hmacSha256Hex,
  pkceChallenge,
  randomToken,
  sha256Hex,
} from "../../worker/lib/crypto";
import { weekBounds } from "../../worker/lib/weeks";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function seedUser(
  id: string,
  email = `${id}@example.com`,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, creem_customer_id, created_at)
     VALUES (?, ?, ?, NULL, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(id, email, "Test User", nowSeconds())
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

describe("basic API surface", () => {
  it("returns 204 from /v1/ping", async () => {
    const response = await SELF.fetch("https://ray.test/v1/ping");
    expect(response.status).toBe(204);
  });

  it("returns a JSON 401 for anonymous /api/me", async () => {
    const response = await SELF.fetch("https://ray.test/api/me");
    expect(response.status).toBe(401);
    expect(await jsonOf(response)).toMatchObject({
      error: "unauthorized",
    });
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const response = await SELF.fetch("https://ray.test/api/nope");
    expect(response.status).toBe(404);
    expect(await jsonOf(response)).toMatchObject({ error: "not_found" });
  });
});

describe("desktop hand-off", () => {
  it("exchanges a one-time code for a device token exactly once", async () => {
    await seedUser("user_handoff");
    const verifier = randomToken();
    const code = randomToken();
    const challenge = await pkceChallenge(verifier);
    await env.DB.prepare(
      `INSERT INTO auth_codes (code_hash, user_id, challenge, state, expires_at, used_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    )
      .bind(
        await sha256Hex(code),
        "user_handoff",
        challenge,
        "state_value",
        nowSeconds() + 300,
      )
      .run();

    const request = () =>
      SELF.fetch("https://ray.test/api/desktop/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, verifier }),
      });

    const first = await request();
    expect(first.status).toBe(200);
    const body = await jsonOf(first);
    expect(body["user"]).toMatchObject({
      id: "user_handoff",
      email: "user_handoff@example.com",
    });
    const token = body["token"];
    expect(typeof token).toBe("string");
    expect(String(token)).toMatch(/^ray_[A-Za-z0-9_-]{43}$/u);

    const replay = await request();
    expect(replay.status).toBe(400);
    expect(await jsonOf(replay)).toMatchObject({ error: "invalid_code" });

    const me = await SELF.fetch("https://ray.test/api/me", {
      headers: { authorization: `Bearer ${String(token)}` },
    });
    expect(me.status).toBe(200);
    const meBody = await jsonOf(me);
    expect(meBody["plan"]).toBe("starter");
    expect(meBody["usage"]).toMatchObject({
      words_used: 0,
      words_limit: 1_000,
    });
    expect(
      typeof (meBody["usage"] as Record<string, unknown>)["week_start"],
    ).toBe("string");
  });

  it("rejects a valid code paired with the wrong verifier", async () => {
    await seedUser("user_verifier");
    const code = randomToken();
    const challenge = await pkceChallenge(randomToken());
    await env.DB.prepare(
      `INSERT INTO auth_codes (code_hash, user_id, challenge, state, expires_at, used_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    )
      .bind(
        await sha256Hex(code),
        "user_verifier",
        challenge,
        "state_value",
        nowSeconds() + 300,
      )
      .run();

    const response = await SELF.fetch(
      "https://ray.test/api/desktop/token",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, verifier: randomToken() }),
      },
    );
    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toMatchObject({
      error: "invalid_verifier",
    });
  });

  it("consumes a code exactly once under concurrent requests", async () => {
    await seedUser("user_concurrent");
    const verifier = randomToken();
    const code = randomToken();
    const challenge = await pkceChallenge(verifier);
    await env.DB.prepare(
      `INSERT INTO auth_codes (code_hash, user_id, challenge, state, expires_at, used_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    )
      .bind(
        await sha256Hex(code),
        "user_concurrent",
        challenge,
        "state_value",
        nowSeconds() + 300,
      )
      .run();

    const exchange = () =>
      SELF.fetch("https://ray.test/api/desktop/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, verifier }),
      });

    const responses = await Promise.all([
      exchange(),
      exchange(),
      exchange(),
    ]);
    const statuses = responses
      .map((response) => response.status)
      .sort((a, b) => a - b);
    expect(statuses).toEqual([200, 400, 400]);
  });

  it("revokes a device on sign-out", async () => {
    await seedUser("user_signout");
    const token = await seedDevice("user_signout");

    const signout = await SELF.fetch(
      "https://ray.test/api/desktop/signout",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(signout.status).toBe(200);

    const me = await SELF.fetch("https://ray.test/api/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(401);
  });

  it("registers /api/devices/revoke-all behind Clerk auth", async () => {
    const response = await SELF.fetch(
      "https://ray.test/api/devices/revoke-all",
      { method: "POST" },
    );
    expect(response.status).toBe(401);
    expect(await jsonOf(response)).toMatchObject({ error: "unauthorized" });
  });
});

describe("usage weeks", () => {
  it("accumulates words atomically in the current week", async () => {
    const weekStart = weekBounds(nowSeconds()).weekStart;
    await addWords(env.DB, "user_usage", weekStart, 400);
    await addWords(env.DB, "user_usage", weekStart, 12);
    expect(await getUsageWords(env.DB, "user_usage", weekStart)).toBe(412);

    // Concurrent UPSERTs must not lose updates.
    await Promise.all(
      Array.from({ length: 20 }, () =>
        addWords(env.DB, "user_usage", weekStart, 5),
      ),
    );
    expect(await getUsageWords(env.DB, "user_usage", weekStart)).toBe(512);

    // A different week is a separate row.
    expect(
      await getUsageWords(env.DB, "user_usage", weekStart + 604_800),
    ).toBe(0);
  });
});

describe("Creem webhooks", () => {
  function webhookEvent(options: {
    id: string;
    updatedAtMs: number;
    status: string;
    eventType: string;
  }): unknown {
    return {
      id: options.id,
      eventType: options.eventType,
      created_at: options.updatedAtMs,
      object: {
        object: "subscription",
        id: "sub_wh",
        status: options.status,
        product: {
          id: "prod_test_monthly",
          recurring_interval: "month",
        },
        customer: { id: "cust_wh", email: "wh@example.com" },
        metadata: { user_id: "user_webhook" },
        current_period_end_date: new Date(
          (nowSeconds() + 30 * 86_400) * 1000,
        ).toISOString(),
        updated_at: options.updatedAtMs,
      },
    };
  }

  async function deliver(
    event: unknown,
    signatureOverride?: string,
  ): Promise<Response> {
    const body = JSON.stringify(event);
    const signature =
      signatureOverride ??
      (await hmacSha256Hex(
        String(env.CREEM_WEBHOOK_SECRET),
        body,
      ));
    return SELF.fetch("https://ray.test/api/webhooks/creem", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "creem-signature": signature,
      },
      body,
    });
  }

  it("verifies the signature and activates a subscription", async () => {
    await seedUser("user_webhook", "wh@example.com");
    const updatedAt = nowSeconds() * 1000;

    const response = await deliver(
      webhookEvent({
        id: "evt_wh_paid",
        updatedAtMs: updatedAt,
        status: "active",
        eventType: "subscription.paid",
      }),
    );
    expect(response.status).toBe(200);

    const subscriptions = await listSubscriptions(env.DB, "user_webhook");
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]).toMatchObject({
      id: "sub_wh",
      status: "active",
      interval: "monthly",
      cancel_at_period_end: 0,
    });

    const user = await env.DB.prepare(
      "SELECT creem_customer_id FROM users WHERE id = ?",
    )
      .bind("user_webhook")
      .first<{ creem_customer_id: string }>();
    expect(user?.creem_customer_id).toBe("cust_wh");
  });

  it("rejects an invalid signature", async () => {
    const response = await deliver(
      webhookEvent({
        id: "evt_wh_bad",
        updatedAtMs: nowSeconds() * 1000,
        status: "active",
        eventType: "subscription.paid",
      }),
      "00".repeat(32),
    );
    expect(response.status).toBe(401);
  });

  it("is idempotent per event id", async () => {
    await seedUser("user_webhook", "wh@example.com");
    const event = webhookEvent({
      id: "evt_wh_dup",
      updatedAtMs: nowSeconds() * 1000,
      status: "active",
      eventType: "subscription.paid",
    });

    expect((await deliver(event)).status).toBe(200);
    const duplicate = await deliver(event);
    expect(duplicate.status).toBe(200);
    expect(await jsonOf(duplicate)).toMatchObject({ duplicate: true });
    expect(await listSubscriptions(env.DB, "user_webhook")).toHaveLength(1);
  });

  it("ignores an older event delivered after a newer one", async () => {
    await seedUser("user_webhook", "wh@example.com");
    const newer = nowSeconds() * 1000;
    const older = newer - 60_000;

    expect(
      (
        await deliver(
          webhookEvent({
            id: "evt_wh_new",
            updatedAtMs: newer,
            status: "active",
            eventType: "subscription.paid",
          }),
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await deliver(
          webhookEvent({
            id: "evt_wh_old",
            updatedAtMs: older,
            status: "canceled",
            eventType: "subscription.canceled",
          }),
        )
      ).status,
    ).toBe(200);

    const subscriptions = await listSubscriptions(env.DB, "user_webhook");
    expect(subscriptions).toHaveLength(1);
    // The stale cancellation must not overwrite the newer active state.
    expect(subscriptions[0]?.status).toBe("active");
  });
});

describe("quota enforcement", () => {
  it("returns the Starter 402 shape at the limit", async () => {
    await seedUser("user_quota");
    const token = await seedDevice("user_quota");
    const weekStart = weekBounds(nowSeconds()).weekStart;
    await addWords(env.DB, "user_quota", weekStart, 1_000);

    const response = await SELF.fetch("https://ray.test/v1/stt/sync", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
      },
      body: "audio",
    });

    expect(response.status).toBe(402);
    expect(await jsonOf(response)).toMatchObject({
      error: "quota_exceeded",
      plan: "starter",
      words_used: 1_000,
      words_limit: 1_000,
    });
  });

  it("does not apply the weekly quota to cleanup (grants only)", async () => {
    await seedUser("user_quota_cleanup");
    const token = await seedDevice("user_quota_cleanup");
    const weekStart = weekBounds(nowSeconds()).weekStart;
    await addWords(env.DB, "user_quota_cleanup", weekStart, 1_000);

    const response = await SELF.fetch(
      "https://ray.test/v1/cleanup/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gemma-4-31b",
          messages: [{ role: "user", content: "<transcript>hi</transcript>" }],
        }),
      },
    );

    // Decision 1: an over-quota user without a grant gets no_cleanup_grant,
    // never quota_exceeded, so the dictation that crossed the line can still
    // be cleaned up.
    expect(response.status).toBe(403);
    expect(await jsonOf(response)).toMatchObject({
      error: "no_cleanup_grant",
    });
  });

  it("hides the fair-use cap in /api/me but returns 429 at it", async () => {
    await seedUser("user_fair");
    const token = await seedDevice("user_fair");
    const now = nowSeconds();
    await env.DB.prepare(
      `INSERT INTO subscriptions
         (id, user_id, product_id, interval, status, current_period_end, cancel_at_period_end, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    )
      .bind(
        "sub_fair",
        "user_fair",
        "prod_test_monthly",
        "monthly",
        "active",
        now + 30 * 86_400,
        now,
      )
      .run();
    await addWords(env.DB, "user_fair", weekBounds(now).weekStart, 100_000);

    const me = await SELF.fetch("https://ray.test/api/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
    const meBody = await jsonOf(me);
    expect(meBody["plan"]).toBe("pro");
    expect(meBody["usage"]).toMatchObject({ words_limit: null });

    const response = await SELF.fetch("https://ray.test/v1/stt/sync", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
      },
      body: "audio",
    });
    expect(response.status).toBe(429);
    const body = await jsonOf(response);
    expect(body["error"]).toBe("fair_use");
    expect(typeof body["resets_at"]).toBe("string");
  });
});
