import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import app from "../../worker/index";
import type { Env } from "../../worker/env";
import {
  addUsage,
  markFreeBlockedIfOverDeviceLimitStatement,
} from "../../worker/db";
import {
  pkceChallenge,
  randomToken,
  sha256Hex,
} from "../../worker/lib/crypto";
import { TRIAL_SECONDS } from "../../worker/lib/plan";
import { nowSeconds, weekBounds } from "../../worker/lib/weeks";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

function workerEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: env.DB,
    SITE_URL: env.SITE_URL,
    CLERK_PUBLISHABLE_KEY: env.CLERK_PUBLISHABLE_KEY,
    CREEM_API_BASE: env.CREEM_API_BASE,
    CREEM_PRODUCT_PRO_MONTHLY: env.CREEM_PRODUCT_PRO_MONTHLY,
    CREEM_PRODUCT_PRO_ANNUAL: env.CREEM_PRODUCT_PRO_ANNUAL,
    STARTER_WEEKLY_WORDS: env.STARTER_WEEKLY_WORDS,
    STARTER_WEEKLY_AUDIO_SECONDS: env.STARTER_WEEKLY_AUDIO_SECONDS,
    FAIR_USE_WEEKLY_AUDIO_SECONDS: env.FAIR_USE_WEEKLY_AUDIO_SECONDS,
    TRIAL_WEEKLY_AUDIO_SECONDS: env.TRIAL_WEEKLY_AUDIO_SECONDS,
    CLEANUP_MODELS: env.CLEANUP_MODELS,
    CLERK_SECRET_KEY: env.CLERK_SECRET_KEY,
    ASSEMBLYAI_API_KEY: env.ASSEMBLYAI_API_KEY,
    CREEM_API_KEY: env.CREEM_API_KEY,
    CREEM_WEBHOOK_SECRET: env.CREEM_WEBHOOK_SECRET,
    CLERK_WEBHOOK_SECRET: env.CLERK_WEBHOOK_SECRET,
    ...overrides,
  };
}

async function seedUser(id: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, creem_customer_id, created_at)
     VALUES (?, ?, NULL, NULL, ?)`,
  )
    .bind(id, `${id}@example.com`, nowSeconds())
    .run();
}

async function seedSubscription(
  userId: string,
  options: {
    id?: string;
    status?: string;
    productId?: string;
    currentPeriodEnd?: number;
  } = {},
): Promise<void> {
  const now = nowSeconds();
  await env.DB.prepare(
    `INSERT INTO subscriptions
       (id, user_id, product_id, interval, status, current_period_end, cancel_at_period_end, updated_at)
     VALUES (?, ?, ?, 'monthly', ?, ?, 0, ?)`,
  )
    .bind(
      options.id ?? `sub_${userId}`,
      userId,
      options.productId ?? String(env.CREEM_PRODUCT_PRO_MONTHLY),
      options.status ?? "active",
      options.currentPeriodEnd ?? now + 30 * 86_400,
      now,
    )
    .run();
}

/** A device token row, as a previously-completed desktop sign-in would leave. */
async function seedDevice(userId: string): Promise<string> {
  const token = `ray_${randomToken()}`;
  await env.DB.prepare(
    `INSERT INTO devices
       (id, user_id, token_hash, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL, NULL)`,
  )
    .bind(
      `dev_${crypto.randomUUID()}`,
      userId,
      await sha256Hex(token),
      nowSeconds(),
    )
    .run();
  return token;
}

async function seedAuthCode(
  userId: string,
): Promise<{ code: string; verifier: string }> {
  const code = randomToken();
  const verifier = randomToken();
  await env.DB.prepare(
    `INSERT INTO auth_codes (code_hash, user_id, challenge, state, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  )
    .bind(
      await sha256Hex(code),
      userId,
      await pkceChallenge(verifier),
      "state_value",
      nowSeconds() + 300,
    )
    .run();
  return { code, verifier };
}

async function exchange(
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(
    new Request("https://ray.test/api/desktop/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    undefined,
    workerEnv(),
  );
}

/** Completes a desktop sign-in and returns the device token. */
async function signIn(userId: string, deviceId: string): Promise<string> {
  const { code, verifier } = await seedAuthCode(userId);
  const response = await exchange({
    code,
    verifier,
    device_id: deviceId,
  });
  expect(response.status).toBe(200);
  const token = (await jsonOf(response))["token"];
  expect(typeof token).toBe("string");
  return String(token);
}

async function fetchMe(
  token: string,
  overrides: Partial<Env> = {},
): Promise<Record<string, unknown>> {
  const response = await app.request(
    new Request("https://ray.test/api/me", {
      headers: { authorization: `Bearer ${token}` },
    }),
    undefined,
    workerEnv(overrides),
  );
  expect(response.status).toBe(200);
  return jsonOf(response);
}

function sttRequest(token: string): Request {
  return new Request("https://ray.test/v1/stt/sync", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "audio/wav",
    },
    body: "audio",
  });
}

async function trialStartedAt(userId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT trial_started_at FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<{ trial_started_at: number | null }>();
  return row?.trial_started_at ?? null;
}

async function freeBlockedAt(userId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT free_blocked_at FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<{ free_blocked_at: number | null }>();
  return row?.free_blocked_at ?? null;
}

/** Consumes a streamed request body like a real upstream would. */
async function drainBody(init: RequestInit | undefined): Promise<void> {
  const body = init?.body as ReadableStream<Uint8Array> | undefined;
  if (!body) return;
  const reader = body.getReader();
  while (!(await reader.read()).done) {
    // Drain until the limiter closes the stream.
  }
}

function stubSyncSuccess(): void {
  vi.stubGlobal(
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      await drainBody(init);
      return new Response(
        JSON.stringify({ text: "hello world", words: [{ text: "hello" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );
}

describe("14-day no-card trial", () => {
  it("starts on the first desktop sign-in with a device id", async () => {
    const userId = "user_trial_start";
    await seedUser(userId);
    const before = nowSeconds();

    const token = await signIn(userId, randomToken());

    const startedAt = await trialStartedAt(userId);
    expect(startedAt).not.toBeNull();
    expect(startedAt).toBeGreaterThanOrEqual(before);
    expect(startedAt).toBeLessThanOrEqual(nowSeconds());

    const me = await fetchMe(token);
    expect(me["plan"]).toBe("pro");
    expect(me["interval"]).toBeNull();
    expect(me["status"]).toBeNull();
    expect(me["billing_issue"]).toBeNull();
    expect(me["free_blocked"]).toBe(false);
    expect(me["usage"]).toMatchObject({ words_limit: null });
    const trial = me["trial"] as { ends_at?: string } | null;
    expect(trial).not.toBeNull();
    expect(Date.parse(String(trial?.ends_at)) / 1000).toBe(
      startedAt! + TRIAL_SECONDS,
    );
  });

  it("requires a device id at token exchange", async () => {
    const userId = "user_trial_no_device";
    await seedUser(userId);
    const { code, verifier } = await seedAuthCode(userId);

    const response = await exchange({ code, verifier });

    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toMatchObject({ error: "invalid_request" });
    expect(await trialStartedAt(userId)).toBeNull();
  });

  it("signs in but grants no trial when the per-IP trial brake denies", async () => {
    const userId = "user_trial_rate_limited";
    await seedUser(userId);
    const { code, verifier } = await seedAuthCode(userId);
    let keySeen = "";

    const response = await app.request(
      new Request("https://ray.test/api/desktop/token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.23",
        },
        body: JSON.stringify({
          code,
          verifier,
          device_id: randomToken(),
        }),
      }),
      undefined,
      workerEnv({
        RATE_LIMIT_TRIAL: {
          limit: async ({ key }) => {
            keySeen = key;
            return { success: false };
          },
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(keySeen).toBe("ip:198.51.100.23");
    expect(await trialStartedAt(userId)).toBeNull();
    const me = await fetchMe(String((await jsonOf(response))["token"]), {
      RATE_LIMIT_TRIAL: {
        limit: async () => ({ success: false }),
      },
    });
    expect(me["plan"]).toBe("starter");
  });

  it("retries a brake-denied trial on the next device request", async () => {
    const userId = "user_trial_retry";
    await seedUser(userId);
    const { code, verifier } = await seedAuthCode(userId);

    const response = await app.request(
      new Request("https://ray.test/api/desktop/token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.24",
        },
        body: JSON.stringify({
          code,
          verifier,
          device_id: randomToken(),
        }),
      }),
      undefined,
      workerEnv({
        RATE_LIMIT_TRIAL: {
          limit: async () => ({ success: false }),
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(await trialStartedAt(userId)).toBeNull();
    const token = String((await jsonOf(response))["token"]);

    // The limited window has passed: the same signed-in device retries the
    // grant on its next authenticated request.
    const me = await fetchMe(token);
    expect(me["plan"]).toBe("pro");
    expect(me["trial"]).not.toBeNull();
    expect(await trialStartedAt(userId)).not.toBeNull();
  });

  it("does not start when the user has ever had a subscription row", async () => {
    const userId = "user_trial_had_sub";
    await seedUser(userId);
    await seedSubscription(userId, {
      status: "expired",
      currentPeriodEnd: nowSeconds() - 86_400,
    });

    const token = await signIn(userId, randomToken());

    expect(await trialStartedAt(userId)).toBeNull();
    const me = await fetchMe(token);
    expect(me["plan"]).toBe("starter");
    expect(me["trial"]).toBeNull();
  });

  it("does not start for a free-blocked account", async () => {
    const userId = "user_trial_blocked";
    await seedUser(userId);
    await env.DB.prepare(
      "UPDATE users SET free_blocked_at = ? WHERE id = ?",
    )
      .bind(nowSeconds(), userId)
      .run();

    const token = await signIn(userId, randomToken());

    expect(await trialStartedAt(userId)).toBeNull();
    const me = await fetchMe(token);
    expect(me["plan"]).toBe("starter");
    expect(me["trial"]).toBeNull();
    expect(me["free_blocked"]).toBe(true);
  });

  it("a paid subscription takes precedence over the trial", async () => {
    const userId = "user_trial_paid";
    await seedUser(userId);
    await env.DB.prepare(
      "UPDATE users SET trial_started_at = ? WHERE id = ?",
    )
      .bind(nowSeconds() - 86_400, userId)
      .run();
    await seedSubscription(userId);

    const me = await fetchMe(await seedDevice(userId));
    expect(me["plan"]).toBe("pro");
    expect(me["interval"]).toBe("monthly");
    expect(me["status"]).toBe("active");
    expect(me["trial"]).toBeNull();
  });

  it("resolves as Starter once the 14 days have passed", async () => {
    const userId = "user_trial_expired";
    await seedUser(userId);
    await env.DB.prepare(
      "UPDATE users SET trial_started_at = ? WHERE id = ?",
    )
      .bind(nowSeconds() - TRIAL_SECONDS - 86_400, userId)
      .run();

    const me = await fetchMe(await seedDevice(userId));
    expect(me["plan"]).toBe("starter");
    expect(me["trial"]).toBeNull();
    expect(me["usage"]).toMatchObject({ words_limit: 1_000 });
  });

  it("does not charge pre-trial usage against Starter in the trial's last week", async () => {
    const userId = "user_trial_midweek";
    await seedUser(userId);
    const now = nowSeconds();
    const weekStart = weekBounds(now).weekStart;
    // A trial that ended earlier this week, including when the test runs in
    // the first minute after the Monday boundary.
    const trialEnd = Math.max(weekStart, now - 60);
    await env.DB.prepare(
      "UPDATE users SET trial_started_at = ? WHERE id = ?",
    )
      .bind(trialEnd - TRIAL_SECONDS, userId)
      .run();
    await addUsage(env.DB, userId, weekStart, 6_000);

    const token = await seedDevice(userId);
    const me = await fetchMe(token);
    expect(me["plan"]).toBe("starter");
    expect(me["usage"]).toMatchObject({
      words_used: 0,
      words_limit: 1_000,
    });

    // The Starter allowance starts at the trial's end, so dictation works
    // immediately; only the words it produces count.
    stubSyncSuccess();
    const response = await app.request(
      sttRequest(token),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(200);

    const after = await fetchMe(token);
    expect(after["usage"]).toMatchObject({ words_used: 1 });
  });

  it("does not charge paid usage against Starter when a subscription ends mid-week", async () => {
    const userId = "user_paid_midweek";
    await seedUser(userId);
    const now = nowSeconds();
    const weekStart = weekBounds(now).weekStart;
    // A paid period that ended earlier this week, including when the test runs
    // in the first minute after the Monday boundary.
    const periodEnd = Math.max(weekStart, now - 60);
    await seedSubscription(userId, {
      status: "canceled",
      currentPeriodEnd: periodEnd,
    });
    await addUsage(env.DB, userId, weekStart, 6_000);

    const token = await seedDevice(userId);
    const me = await fetchMe(token);
    expect(me["plan"]).toBe("starter");
    expect(me["usage"]).toMatchObject({
      words_used: 0,
      words_limit: 1_000,
    });

    // Only usage produced after the paid period ends counts against Starter.
    stubSyncSuccess();
    const response = await app.request(
      sttRequest(token),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(200);

    const after = await fetchMe(token);
    expect(after["usage"]).toMatchObject({ words_used: 1 });
  });

  it("still resolves as Pro on the last second of the trial", async () => {
    const userId = "user_trial_last_second";
    await seedUser(userId);
    await env.DB.prepare(
      "UPDATE users SET trial_started_at = ? WHERE id = ?",
    )
      .bind(nowSeconds() - TRIAL_SECONDS + 60, userId)
      .run();

    const me = await fetchMe(await seedDevice(userId));
    expect(me["plan"]).toBe("pro");
    expect(me["trial"]).not.toBeNull();
  });
});

describe("per-PC free-account limit", () => {
  it("allows the first three distinct accounts on a PC", async () => {
    const deviceId = randomToken();
    for (const userId of ["user_pc_a", "user_pc_b", "user_pc_c"]) {
      await seedUser(userId);
      const token = await signIn(userId, deviceId);
      expect(await freeBlockedAt(userId)).toBeNull();
      const me = await fetchMe(token);
      expect(me["free_blocked"]).toBe(false);
      expect(me["plan"]).toBe("pro");
    }
  });

  it("blocks the fourth distinct account on a PC", async () => {
    const deviceId = randomToken();
    for (const userId of ["user_pc_d_a", "user_pc_d_b", "user_pc_d_c"]) {
      await seedUser(userId);
      await signIn(userId, deviceId);
    }
    const userId = "user_pc_d_fourth";
    await seedUser(userId);

    const token = await signIn(userId, deviceId);

    expect(await freeBlockedAt(userId)).not.toBeNull();
    // The first three accounts are never affected.
    for (const other of ["user_pc_d_a", "user_pc_d_b", "user_pc_d_c"]) {
      expect(await freeBlockedAt(other)).toBeNull();
    }
    const me = await fetchMe(token);
    expect(me["free_blocked"]).toBe(true);
    expect(me["plan"]).toBe("starter");
    expect(me["trial"]).toBeNull();
  });

  it("never blocks an earlier account that re-signs in after the fourth account", async () => {
    const deviceId = randomToken();
    for (const userId of ["user_pc_r_a", "user_pc_r_b", "user_pc_r_c"]) {
      await seedUser(userId);
      await signIn(userId, deviceId);
    }
    // D is the fourth distinct account and is blocked as expected.
    await seedUser("user_pc_r_d");
    await signIn("user_pc_r_d", deviceId);
    expect(await freeBlockedAt("user_pc_r_d")).not.toBeNull();

    // A already had a row on this PC, so re-signing in is not a new account
    // and must not suppress its active trial or free access.
    const token = await signIn("user_pc_r_a", deviceId);

    expect(await freeBlockedAt("user_pc_r_a")).toBeNull();
    const me = await fetchMe(token);
    expect(me["free_blocked"]).toBe(false);
    expect(me["plan"]).toBe("pro");
  });

  it("serializes concurrent sign-ins to exactly three free accounts", async () => {
    const deviceId = randomToken();
    for (const userId of ["user_pc_cc_a", "user_pc_cc_b"]) {
      await seedUser(userId);
      await signIn(userId, deviceId);
    }
    for (const userId of ["user_pc_cc_c", "user_pc_cc_d"]) {
      await seedUser(userId);
    }

    await Promise.all([
      signIn("user_pc_cc_c", deviceId),
      signIn("user_pc_cc_d", deviceId),
    ]);

    const states = await Promise.all(
      ["user_pc_cc_a", "user_pc_cc_b", "user_pc_cc_c", "user_pc_cc_d"].map(
        (userId) => freeBlockedAt(userId),
      ),
    );
    expect(states.filter((value) => value === null)).toHaveLength(3);
  });

  it("orders the PC limit by insertion order, not the request clock", async () => {
    const deviceId = randomToken();
    const deviceHash = await sha256Hex(deviceId);
    const now = nowSeconds();
    const earlier = ["order_a", "order_b", "order_c"];
    for (const suffix of earlier) {
      await seedUser(`user_pc_${suffix}`);
      await env.DB.prepare(
        `INSERT INTO devices (id, user_id, token_hash, created_at, device_hash)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(
          `dev_${suffix}`,
          `user_pc_${suffix}`,
          await sha256Hex(`token_${suffix}`),
          now,
          deviceHash,
        )
        .run();
    }
    // Inserted after the three rows above but carrying an earlier clock
    // reading, which is what a concurrent token handler can produce when it
    // reads `now` before its INSERT.
    await seedUser("user_pc_order_d");
    await env.DB.prepare(
      `INSERT INTO devices (id, user_id, token_hash, created_at, device_hash)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        "dev_order_d",
        "user_pc_order_d",
        await sha256Hex("token_order_d"),
        now - 60,
        deviceHash,
      )
      .run();

    const result = await markFreeBlockedIfOverDeviceLimitStatement(env.DB, {
      userId: "user_pc_order_d",
      deviceRowId: "dev_order_d",
      now,
    }).run();

    expect((result.meta.changes ?? 0) > 0).toBe(true);
    expect(await freeBlockedAt("user_pc_order_d")).not.toBeNull();
  });

  it("revoked device rows still count toward the PC limit", async () => {
    const deviceId = randomToken();
    const deviceHash = await sha256Hex(deviceId);
    for (const userId of ["user_pc_v_a", "user_pc_v_b", "user_pc_v_c"]) {
      await seedUser(userId);
      await signIn(userId, deviceId);
    }
    await env.DB.prepare(
      "UPDATE devices SET revoked_at = ? WHERE user_id = ?",
    )
      .bind(nowSeconds(), "user_pc_v_b")
      .run();

    const userId = "user_pc_v_fourth";
    await seedUser(userId);
    const token = await signIn(userId, deviceId);

    expect(await freeBlockedAt(userId)).not.toBeNull();
    const row = await env.DB.prepare(
      "SELECT COUNT(DISTINCT user_id) AS users FROM devices WHERE device_hash = ?",
    )
      .bind(deviceHash)
      .first<{ users: number }>();
    expect(row?.users).toBe(4);
    expect((await fetchMe(token))["free_blocked"]).toBe(true);
  });

  it("rejects a malformed device_id without consuming the sign-in", async () => {
    const userId = "user_pc_bad_id";
    await seedUser(userId);
    const { code, verifier } = await seedAuthCode(userId);

    const response = await exchange({
      code,
      verifier,
      device_id: "not-a-valid-device-id",
    });
    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toMatchObject({ error: "invalid_request" });
    expect(await trialStartedAt(userId)).toBeNull();
  });

  it("answers 402 device_limit to a blocked free account", async () => {
    const userId = "user_pc_blocked_stt";
    await seedUser(userId);
    await env.DB.prepare(
      "UPDATE users SET free_blocked_at = ? WHERE id = ?",
    )
      .bind(nowSeconds(), userId)
      .run();
    const token = await seedDevice(userId);

    const response = await app.request(
      sttRequest(token),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(402);
    expect(await jsonOf(response)).toMatchObject({
      error: "device_limit",
      message:
        "This account can't use the free plan because too many accounts were created on one PC. Upgrade to Pro to keep dictating.",
    });
    expect((await fetchMe(token))["free_blocked"]).toBe(true);
  });

  it("does not block a paid Pro subscription on a blocked PC", async () => {
    const userId = "user_pc_blocked_paid";
    await seedUser(userId);
    await env.DB.prepare(
      "UPDATE users SET free_blocked_at = ? WHERE id = ?",
    )
      .bind(nowSeconds(), userId)
      .run();
    await seedSubscription(userId);
    const token = await seedDevice(userId);
    stubSyncSuccess();

    const response = await app.request(
      sttRequest(token),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toMatchObject({ text: "hello world" });
  });
});

describe("time-based fair use", () => {
  it("blocks a trial at its 3-hour weekly audio budget with fair_use", async () => {
    const userId = "user_trial_audio";
    await seedUser(userId);
    await env.DB.prepare(
      "UPDATE users SET trial_started_at = ? WHERE id = ?",
    )
      .bind(nowSeconds() - 86_400, userId)
      .run();
    const token = await seedDevice(userId);
    await addUsage(env.DB, userId, weekBounds(nowSeconds()).weekStart, 0, 10_800);

    const response = await app.request(
      sttRequest(token),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(429);
    expect(await jsonOf(response)).toMatchObject({ error: "fair_use" });
  });

  it("allows a trial just below its audio budget", async () => {
    const userId = "user_trial_audio_ok";
    await seedUser(userId);
    await env.DB.prepare(
      "UPDATE users SET trial_started_at = ? WHERE id = ?",
    )
      .bind(nowSeconds() - 86_400, userId)
      .run();
    const token = await seedDevice(userId);
    await addUsage(env.DB, userId, weekBounds(nowSeconds()).weekStart, 0, 10_799);
    stubSyncSuccess();

    const response = await app.request(
      sttRequest(token),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(200);
  });

  it("has no weekly word cap for Pro", async () => {
    const userId = "user_pro_no_word_cap";
    await seedUser(userId);
    await seedSubscription(userId);
    const token = await seedDevice(userId);
    // Far beyond the old 100,000-word fair-use cap.
    await addUsage(
      env.DB,
      userId,
      weekBounds(nowSeconds()).weekStart,
      500_000,
    );
    stubSyncSuccess();

    const response = await app.request(
      sttRequest(token),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toMatchObject({ text: "hello world" });
  });

  it("has no weekly word cap for a trial", async () => {
    const userId = "user_trial_no_word_cap";
    await seedUser(userId);
    await env.DB.prepare(
      "UPDATE users SET trial_started_at = ? WHERE id = ?",
    )
      .bind(nowSeconds() - 86_400, userId)
      .run();
    const token = await seedDevice(userId);
    await addUsage(
      env.DB,
      userId,
      weekBounds(nowSeconds()).weekStart,
      500_000,
    );
    stubSyncSuccess();

    const response = await app.request(
      sttRequest(token),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(200);
  });

  it("keeps the Pro 7-hour audio fair-use cap", async () => {
    const userId = "user_pro_audio_cap";
    await seedUser(userId);
    await seedSubscription(userId);
    const token = await seedDevice(userId);
    await addUsage(
      env.DB,
      userId,
      weekBounds(nowSeconds()).weekStart,
      0,
      25_200,
    );

    const response = await app.request(
      sttRequest(token),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(429);
    expect(await jsonOf(response)).toMatchObject({ error: "fair_use" });
  });
});

describe("checkout during a trial", () => {
  it("allows a trial user to start an upgrade checkout", async () => {
    const userId = "user_trial_checkout";
    await seedUser(userId);
    await env.DB.prepare(
      "UPDATE users SET trial_started_at = ? WHERE id = ?",
    )
      .bind(nowSeconds() - 86_400, userId)
      .run();
    const token = await seedDevice(userId);
    const calls: { url: string }[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL) => {
        calls.push({ url: String(input) });
        return new Response(
          JSON.stringify({ checkout_url: "https://checkout.test/session" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );

    const response = await app.request(
      new Request("https://ray.test/api/billing/checkout", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ interval: "annual" }),
      }),
      undefined,
      workerEnv(),
    );

    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toMatchObject({
      url: "https://checkout.test/session",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/checkouts");
  });

  it("still refuses checkout for an already paid user", async () => {
    const userId = "user_paid_checkout";
    await seedUser(userId);
    await seedSubscription(userId);
    const token = await seedDevice(userId);

    const response = await app.request(
      new Request("https://ray.test/api/billing/checkout", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ interval: "monthly" }),
      }),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(409);
    expect(await jsonOf(response)).toMatchObject({
      error: "already_subscribed",
    });
  });
});
