import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  acquireSttLease,
  addSttFailure,
  addUsage,
  consumeCleanupGrant,
  getSttFailures,
  getSubscription,
  getUser,
  grantCleanup,
  releaseSttLease,
  revokeAllDevices,
  STT_LEASE_LIMIT,
  upsertSubscriptionIfNewer,
  upsertUser,
  usageForPlan,
} from "../worker/db";
import type { SubscriptionRow } from "../worker/env";
import { nowSeconds, weekBounds } from "../worker/lib/weeks";

function now(): number {
  return nowSeconds();
}

async function seedUser(id: string, email: string | null = null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, creem_customer_id, created_at)
     VALUES (?, ?, NULL, NULL, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(id, email, now())
    .run();
}

async function seedDevice(userId: string): Promise<string> {
  const id = `dev_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO devices (id, user_id, token_hash, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL, NULL)`,
  )
    .bind(id, userId, `hash_${id}`, now())
    .run();
  return id;
}

async function getGrant(
  userId: string,
): Promise<{ words: number; calls_left: number; expires_at: number } | null> {
  return env.DB.prepare(
    "SELECT words, calls_left, expires_at FROM cleanup_grants WHERE user_id = ?",
  )
    .bind(userId)
    .first();
}

function subscription(
  overrides: Partial<SubscriptionRow> = {},
): SubscriptionRow {
  return {
    id: "sub_ties",
    user_id: "user_ties",
    product_id: "prod_monthly",
    interval: "monthly",
    status: "active",
    current_period_end: now() + 30 * 86_400,
    cancel_at_period_end: 0,
    updated_at: 1_000,
    ...overrides,
  };
}

describe("cleanup grants", () => {
  it("accrues words and calls, refreshing the 15-minute window", async () => {
    const userId = "user_grant_accrue";
    await grantCleanup(env.DB, userId, 10, 1_000, 6, 30, 900);
    expect(await getGrant(userId)).toEqual({
      words: 10,
      calls_left: 6,
      expires_at: 1_900,
    });

    await grantCleanup(env.DB, userId, 5, 1_100, 6, 30, 900);
    expect(await getGrant(userId)).toEqual({
      words: 15,
      calls_left: 12,
      expires_at: 2_000,
    });

    // Calls regenerate but are capped at 30.
    for (let index = 0; index < 5; index += 1) {
      await grantCleanup(env.DB, userId, 1, 1_200 + index, 6, 30, 900);
    }
    expect((await getGrant(userId))?.calls_left).toBe(30);
    expect((await getGrant(userId))?.words).toBe(20);
  });

  it("restarts an expired grant from the latest transcription", async () => {
    const userId = "user_grant_expired";
    await grantCleanup(env.DB, userId, 40, 1_000, 6, 30, 900);
    await env.DB.prepare(
      "UPDATE cleanup_grants SET expires_at = ? WHERE user_id = ?",
    )
      .bind(1_500, userId)
      .run();

    await grantCleanup(env.DB, userId, 7, 2_000, 6, 30, 900);
    expect(await getGrant(userId)).toEqual({
      words: 7,
      calls_left: 6,
      expires_at: 2_900,
    });
  });

  it("ignores non-positive counts", async () => {
    await grantCleanup(env.DB, "user_grant_zero", 0, 1_000, 6, 30, 900);
    expect(await getGrant("user_grant_zero")).toBeNull();
  });

  it("atomically decrements calls and returns the word budget", async () => {
    const userId = "user_grant_consume";
    await grantCleanup(env.DB, userId, 12, now(), 2, 30, 900);

    const first = await consumeCleanupGrant(env.DB, userId, now());
    expect(first).toEqual({ words: 12 });
    const second = await consumeCleanupGrant(env.DB, userId, now());
    expect(second).toEqual({ words: 12 });
    expect(await consumeCleanupGrant(env.DB, userId, now())).toBeNull();
  });

  it("returns null for expired grants", async () => {
    const userId = "user_grant_consume_expired";
    await grantCleanup(env.DB, userId, 12, now(), 6, 30, 900);
    expect(
      await consumeCleanupGrant(env.DB, userId, now() + 901),
    ).toBeNull();
  });
});

describe("STT concurrency leases", () => {
  it(`allows at most ${STT_LEASE_LIMIT} concurrent leases per user`, async () => {
    const userId = "user_lease_cap";
    const nowTs = now();
    expect(
      await acquireSttLease(
        env.DB,
        "lease_a",
        userId,
        nowTs,
        nowTs + 360,
        STT_LEASE_LIMIT,
      ),
    ).toBe(true);
    expect(
      await acquireSttLease(
        env.DB,
        "lease_b",
        userId,
        nowTs,
        nowTs + 360,
        STT_LEASE_LIMIT,
      ),
    ).toBe(true);
    expect(
      await acquireSttLease(
        env.DB,
        "lease_c",
        userId,
        nowTs,
        nowTs + 360,
        STT_LEASE_LIMIT,
      ),
    ).toBe(false);

    await releaseSttLease(env.DB, "lease_a");
    expect(
      await acquireSttLease(
        env.DB,
        "lease_d",
        userId,
        nowTs,
        nowTs + 360,
        STT_LEASE_LIMIT,
      ),
    ).toBe(true);
  });

  it("caps concurrent acquisitions at the lease limit", async () => {
    const userId = "user_lease_concurrent";
    const nowTs = now();
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        acquireSttLease(
          env.DB,
          `lease_${index}`,
          userId,
          nowTs,
          nowTs + 360,
          STT_LEASE_LIMIT,
        ),
      ),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(STT_LEASE_LIMIT);
  });

  it("ignores and clears expired leases", async () => {
    const userId = "user_lease_expired";
    const nowTs = now();
    await env.DB.prepare(
      "INSERT INTO stt_leases (id, user_id, expires_at) VALUES (?, ?, ?)",
    )
      .bind("lease_stale", userId, nowTs - 1)
      .run();
    expect(
      await acquireSttLease(
        env.DB,
        "lease_fresh",
        userId,
        nowTs,
        nowTs + 360,
        STT_LEASE_LIMIT,
      ),
    ).toBe(true);
    const rows = await env.DB.prepare(
      "SELECT id FROM stt_leases WHERE user_id = ?",
    )
      .bind(userId)
      .all<{ id: string }>();
    expect(rows.results?.map((row) => row.id)).toEqual(["lease_fresh"]);
  });
});

describe("STT failure accounting", () => {
  it("counts failures per user and week", async () => {
    const weekStart = weekBounds(now()).weekStart;
    const userId = "user_failure_counts";
    await addSttFailure(env.DB, userId, weekStart);
    await addSttFailure(env.DB, userId, weekStart);
    await addSttFailure(env.DB, userId, weekStart);
    expect(await getSttFailures(env.DB, userId, weekStart)).toBe(3);
    expect(
      await getSttFailures(env.DB, userId, weekStart + 604_800),
    ).toBe(0);
  });
});

describe("device and user lifecycle", () => {
  it("revokes every device for a user", async () => {
    const userId = "user_revoke_all";
    await seedUser(userId);
    await seedDevice(userId);
    await seedDevice(userId);

    expect(await revokeAllDevices(env.DB, userId, now())).toBe(2);
    expect(await revokeAllDevices(env.DB, userId, now())).toBe(0);
    const rows = await env.DB.prepare(
      "SELECT revoked_at FROM devices WHERE user_id = ?",
    )
      .bind(userId)
      .all<{ revoked_at: number | null }>();
    expect(rows.results?.every((row) => row.revoked_at !== null)).toBe(true);
  });

  it("hides soft-deleted users and does not resurrect them", async () => {
    const userId = "user_deleted";
    await seedUser(userId, "deleted@example.com");
    await env.DB.prepare("UPDATE users SET deleted_at = ? WHERE id = ?")
      .bind(now(), userId)
      .run();

    expect(await getUser(env.DB, userId)).toBeNull();
    expect(
      await upsertUser(env.DB, {
        id: userId,
        email: "deleted@example.com",
        name: "Ghost",
        createdAt: now(),
      }),
    ).toBeNull();
    expect(await getUser(env.DB, userId)).toBeNull();
  });

  it("enforces one user per Creem customer id", async () => {
    await seedUser("user_customer_a");
    await seedUser("user_customer_b");
    await env.DB.prepare(
      "UPDATE users SET creem_customer_id = ? WHERE id = ?",
    )
      .bind("cust_unique", "user_customer_a")
      .run();
    await expect(
      env.DB.prepare("UPDATE users SET creem_customer_id = ? WHERE id = ?")
        .bind("cust_unique", "user_customer_b")
        .run(),
    ).rejects.toThrow();
  });
});

describe("subscription ordering", () => {
  const userId = "user_ties";
  const base = subscription();

  it("applies a revoked event that ties an active event", async () => {
    await seedUser(userId);
    expect(await upsertSubscriptionIfNewer(env.DB, base)).toBe(true);
    expect(
      await upsertSubscriptionIfNewer(
        env.DB,
        subscription({ status: "revoked", updated_at: 1_000 }),
      ),
    ).toBe(true);
    expect((await getSubscription(env.DB, "sub_ties"))?.status).toBe(
      "revoked",
    );
  });

  it("does not let an equal-timestamp active event overwrite revoked", async () => {
    expect(
      await upsertSubscriptionIfNewer(
        env.DB,
        subscription({ status: "active", updated_at: 1_000 }),
      ),
    ).toBe(false);
    expect((await getSubscription(env.DB, "sub_ties"))?.status).toBe(
      "revoked",
    );
  });

  it("does allow a genuinely newer active event to recover", async () => {
    expect(
      await upsertSubscriptionIfNewer(
        env.DB,
        subscription({ status: "active", updated_at: 1_001 }),
      ),
    ).toBe(true);
    expect((await getSubscription(env.DB, "sub_ties"))?.status).toBe(
      "active",
    );
  });
});

describe("Starter baseline after repeated Pro ends", () => {
  it("re-snapshots when a later Pro end lands in the same week", async () => {
    const userId = "user_baseline_repeat";
    await seedUser(userId);
    const weekStart = 1_760_000_000;
    const trialEnd = weekStart + 3_600;
    const refundAt = weekStart + 2 * 86_400;

    // The trial's usage earlier in the week is snapshotted when it ends.
    await addUsage(env.DB, userId, weekStart, 500);
    let user = await getUser(env.DB, userId);
    expect(user).not.toBeNull();
    expect(
      await usageForPlan(
        env.DB,
        user!,
        weekStart,
        { words: 500, audioSeconds: 0 },
        trialEnd,
      ),
    ).toEqual({ words: 0, audioSeconds: 0 });
    expect(
      (await getUser(env.DB, userId))?.starter_baseline_pro_ended_at,
    ).toBe(trialEnd);

    // The user upgrades and is refunded in the same week. The Pro usage must
    // not count against the new Starter allowance.
    await addUsage(env.DB, userId, weekStart, 200);
    user = await getUser(env.DB, userId);
    expect(
      await usageForPlan(
        env.DB,
        user!,
        weekStart,
        { words: 700, audioSeconds: 0 },
        refundAt,
      ),
    ).toEqual({ words: 0, audioSeconds: 0 });
    expect(
      (await getUser(env.DB, userId))?.starter_baseline_pro_ended_at,
    ).toBe(refundAt);

    // Starter usage after the refund counts against the fresh baseline.
    await addUsage(env.DB, userId, weekStart, 100);
    user = await getUser(env.DB, userId);
    expect(
      await usageForPlan(
        env.DB,
        user!,
        weekStart,
        { words: 800, audioSeconds: 0 },
        refundAt,
      ),
    ).toEqual({ words: 100, audioSeconds: 0 });

    // A stale request carrying the earlier Pro end cannot reset the baseline.
    expect(
      await usageForPlan(
        env.DB,
        user!,
        weekStart,
        { words: 800, audioSeconds: 0 },
        trialEnd,
      ),
    ).toEqual({ words: 100, audioSeconds: 0 });
  });
});
