/** All D1 access lives here so the route handlers stay readable. */

import type {
  AuthCodeRow,
  DeviceRow,
  SubscriptionRow,
  UserRow,
} from "./env";

export async function getUser(
  db: D1Database,
  id: string,
): Promise<UserRow | null> {
  return db
    .prepare(
      "SELECT id, email, name, creem_customer_id, created_at FROM users WHERE id = ?",
    )
    .bind(id)
    .first<UserRow>();
}

export interface UpsertUserInput {
  id: string;
  email: string | null;
  name: string | null;
  createdAt: number;
}

/** Inserts a user or fills in a missing email/name without clobbering them. */
export async function upsertUser(
  db: D1Database,
  input: UpsertUserInput,
): Promise<UserRow | null> {
  await db
    .prepare(
      `INSERT INTO users (id, email, name, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email = COALESCE(users.email, excluded.email),
         name = COALESCE(users.name, excluded.name)`,
    )
    .bind(input.id, input.email, input.name, input.createdAt)
    .run();
  return getUser(db, input.id);
}

export async function findUserByCreemCustomerId(
  db: D1Database,
  customerId: string,
): Promise<UserRow | null> {
  return db
    .prepare(
      `SELECT id, email, name, creem_customer_id, created_at
       FROM users WHERE creem_customer_id = ?
       ORDER BY created_at ASC LIMIT 1`,
    )
    .bind(customerId)
    .first<UserRow>();
}

export async function findUserByEmail(
  db: D1Database,
  email: string,
): Promise<UserRow | null> {
  return db
    .prepare(
      `SELECT id, email, name, creem_customer_id, created_at
       FROM users WHERE email IS NOT NULL AND LOWER(email) = LOWER(?)
       ORDER BY created_at ASC LIMIT 1`,
    )
    .bind(email)
    .first<UserRow>();
}

export async function setCreemCustomerId(
  db: D1Database,
  userId: string,
  customerId: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE users SET creem_customer_id = ? WHERE id = ? AND (creem_customer_id IS NULL OR creem_customer_id != ?)",
    )
    .bind(customerId, userId, customerId)
    .run();
}

export async function getUsageWords(
  db: D1Database,
  userId: string,
  weekStart: number,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT words FROM usage_weeks WHERE user_id = ? AND week_start = ?",
    )
    .bind(userId, weekStart)
    .first<{ words: number }>();
  return row?.words ?? 0;
}

/**
 * Atomic UPSERT so concurrent dictations cannot lose counts:
 * INSERT ... ON CONFLICT DO UPDATE SET words = words + excluded.words.
 */
export async function addWords(
  db: D1Database,
  userId: string,
  weekStart: number,
  words: number,
): Promise<void> {
  if (words <= 0) return;
  await db
    .prepare(
      `INSERT INTO usage_weeks (user_id, week_start, words)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, week_start) DO UPDATE SET
         words = usage_weeks.words + excluded.words`,
    )
    .bind(userId, weekStart, words)
    .run();
}

export async function listSubscriptions(
  db: D1Database,
  userId: string,
): Promise<SubscriptionRow[]> {
  const result = await db
    .prepare(
      `SELECT id, user_id, product_id, interval, status,
              current_period_end, cancel_at_period_end, updated_at
       FROM subscriptions WHERE user_id = ?
       ORDER BY updated_at DESC`,
    )
    .bind(userId)
    .all<SubscriptionRow>();
  return result.results ?? [];
}

/**
 * Applies a subscription snapshot only when the event is at least as new as
 * the stored row (`updated_at` is unix milliseconds). Returns false when an
 * older event was ignored.
 */
export async function upsertSubscriptionIfNewer(
  db: D1Database,
  subscription: SubscriptionRow,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO subscriptions
         (id, user_id, product_id, interval, status,
          current_period_end, cancel_at_period_end, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         user_id = excluded.user_id,
         product_id = excluded.product_id,
         interval = excluded.interval,
         status = excluded.status,
         current_period_end = excluded.current_period_end,
         cancel_at_period_end = excluded.cancel_at_period_end,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at >= subscriptions.updated_at`,
    )
    .bind(
      subscription.id,
      subscription.user_id,
      subscription.product_id,
      subscription.interval,
      subscription.status,
      subscription.current_period_end,
      subscription.cancel_at_period_end,
      subscription.updated_at,
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Returns true when this event id was not seen before. */
export async function recordWebhookEvent(
  db: D1Database,
  id: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO webhook_events (id, received_at) VALUES (?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(id, now)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteWebhookEvent(
  db: D1Database,
  id: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM webhook_events WHERE id = ?")
    .bind(id)
    .run();
}

export async function deleteOldWebhookEvents(
  db: D1Database,
  before: number,
): Promise<void> {
  await db
    .prepare("DELETE FROM webhook_events WHERE received_at < ?")
    .bind(before)
    .run();
}

export interface CreateAuthCodeInput {
  codeHash: string;
  userId: string;
  challenge: string;
  state: string;
  expiresAt: number;
}

export async function createAuthCode(
  db: D1Database,
  input: CreateAuthCodeInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO auth_codes (code_hash, user_id, challenge, state, expires_at, used_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      input.codeHash,
      input.userId,
      input.challenge,
      input.state,
      input.expiresAt,
    )
    .run();
}

export async function deleteExpiredAuthCodes(
  db: D1Database,
  now: number,
): Promise<void> {
  await db
    .prepare("DELETE FROM auth_codes WHERE expires_at < ?")
    .bind(now)
    .run();
}

export async function findAuthCode(
  db: D1Database,
  codeHash: string,
): Promise<AuthCodeRow | null> {
  return db
    .prepare(
      `SELECT code_hash, user_id, challenge, state, expires_at, used_at
       FROM auth_codes WHERE code_hash = ?`,
    )
    .bind(codeHash)
    .first<AuthCodeRow>();
}

/** Single-use enforcement: succeeds only for an unused, unexpired code. */
export async function consumeAuthCode(
  db: D1Database,
  codeHash: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE auth_codes SET used_at = ?
       WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
    )
    .bind(now, codeHash, now)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export interface CreateDeviceInput {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: number;
}

export async function createDevice(
  db: D1Database,
  input: CreateDeviceInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO devices (id, user_id, token_hash, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL, NULL)`,
    )
    .bind(input.id, input.userId, input.tokenHash, input.createdAt)
    .run();
}

export async function findDeviceByTokenHash(
  db: D1Database,
  tokenHash: string,
): Promise<DeviceRow | null> {
  return db
    .prepare(
      `SELECT id, user_id, last_used_at, revoked_at
       FROM devices WHERE token_hash = ?`,
    )
    .bind(tokenHash)
    .first<DeviceRow>();
}

/** Throttles last_used_at writes to at most once per `staleBefore` seconds. */
export async function touchDevice(
  db: D1Database,
  deviceId: string,
  now: number,
  staleBefore: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE devices SET last_used_at = ?
       WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
    )
    .bind(now, deviceId, staleBefore)
    .run();
}

export async function revokeDevice(
  db: D1Database,
  deviceId: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    )
    .bind(now, deviceId)
    .run();
}
