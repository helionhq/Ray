/** All D1 access lives here so the route handlers stay readable. */

import type {
  AuthCodeRow,
  DeviceRow,
  SubscriptionRow,
  UserRow,
} from "./env";

/** At most this many in-flight STT requests per user (decision 3). */
export const STT_LEASE_LIMIT = 2;
/** Leases older than this are ignored even if a release was lost. */
export const STT_LEASE_TTL_SECONDS = 6 * 60;

export async function getUser(
  db: D1Database,
  id: string,
): Promise<UserRow | null> {
  return db
    .prepare(
      `SELECT id, email, name, creem_customer_id, created_at,
              trial_started_at, free_blocked_at
       FROM users WHERE id = ? AND deleted_at IS NULL`,
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

/** The user upsert used by Clerk auth and webhook ingestion. Never modifies a
 * deleted user, so a late webhook cannot restore cleared PII. */
export function upsertUserStatement(
  db: D1Database,
  input: UpsertUserInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO users (id, email, name, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email = COALESCE(users.email, excluded.email),
         name = COALESCE(users.name, excluded.name)
       WHERE users.deleted_at IS NULL`,
    )
    .bind(input.id, input.email, input.name, input.createdAt);
}

/** Inserts a user or fills in a missing email/name without clobbering them. */
export async function upsertUser(
  db: D1Database,
  input: UpsertUserInput,
): Promise<UserRow | null> {
  await upsertUserStatement(db, input).run();
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

/**
 * Webhooks map users by metadata.user_id, then creem_customer_id. Email is
 * deliberately not used (decision 8): it is not a verified account binding.
 */
export function setCreemCustomerIdStatement(
  db: D1Database,
  userId: string,
  customerId: string,
): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE users SET creem_customer_id = ? WHERE id = ? AND deleted_at IS NULL AND (creem_customer_id IS NULL OR creem_customer_id != ?)",
    )
    .bind(customerId, userId, customerId);
}

export async function setCreemCustomerId(
  db: D1Database,
  userId: string,
  customerId: string,
): Promise<void> {
  await setCreemCustomerIdStatement(db, userId, customerId).run();
}

/**
 * Atomically claims the single in-flight checkout slot for a user. The
 * returned result has `meta.changes > 0` when the slot was claimed (there was
 * no pending row, or the previous one is older than `ttlSeconds`), and `0`
 * when a recent checkout is still waiting for its webhook.
 */
export function claimPendingCheckoutStatement(
  db: D1Database,
  userId: string,
  now: number,
  ttlSeconds: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO pending_checkouts (user_id, created_at)
       VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET created_at = excluded.created_at
       WHERE pending_checkouts.created_at <= ?`,
    )
    .bind(userId, now, now - ttlSeconds);
}

/** Releases a claim only if it is still the one this checkout created. */
export function releasePendingCheckoutStatement(
  db: D1Database,
  userId: string,
  createdAt: number,
): D1PreparedStatement {
  return db
    .prepare(
      "DELETE FROM pending_checkouts WHERE user_id = ? AND created_at = ?",
    )
    .bind(userId, createdAt);
}

/**
 * Releases the in-flight checkout claim for a user. Only an `active`/
 * `trialing` webhook that was newly applied proves a checkout completed; a
 * late or duplicate event for an old subscription must not call this.
 */
export function clearPendingCheckoutStatement(
  db: D1Database,
  userId: string,
): D1PreparedStatement {
  return db
    .prepare("DELETE FROM pending_checkouts WHERE user_id = ?")
    .bind(userId);
}

export interface WeeklyUsage {
  words: number;
  audioSeconds: number;
}

/** This week's metered usage. Audio seconds stay internal (never in /api/me). */
export async function getUsage(
  db: D1Database,
  userId: string,
  weekStart: number,
): Promise<WeeklyUsage> {
  const row = await db
    .prepare(
      `SELECT words, audio_seconds FROM usage_weeks
       WHERE user_id = ? AND week_start = ?`,
    )
    .bind(userId, weekStart)
    .first<{ words: number; audio_seconds: number }>();
  return {
    words: row?.words ?? 0,
    audioSeconds: row?.audio_seconds ?? 0,
  };
}

export async function getUsageWords(
  db: D1Database,
  userId: string,
  weekStart: number,
): Promise<number> {
  return (await getUsage(db, userId, weekStart)).words;
}

/**
 * Atomic UPSERT so concurrent dictations cannot lose counts:
 * INSERT ... ON CONFLICT DO UPDATE SET words = words + excluded.words,
 * audio_seconds = audio_seconds + excluded.audio_seconds.
 */
export async function addUsage(
  db: D1Database,
  userId: string,
  weekStart: number,
  words: number,
  audioSeconds = 0,
): Promise<void> {
  if (words <= 0 && audioSeconds <= 0) return;
  await db
    .prepare(
      `INSERT INTO usage_weeks (user_id, week_start, words, audio_seconds)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, week_start) DO UPDATE SET
         words = usage_weeks.words + excluded.words,
         audio_seconds = usage_weeks.audio_seconds + excluded.audio_seconds`,
    )
    .bind(userId, weekStart, words, audioSeconds)
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

export async function getSubscription(
  db: D1Database,
  id: string,
): Promise<SubscriptionRow | null> {
  return db
    .prepare(
      `SELECT id, user_id, product_id, interval, status,
              current_period_end, cancel_at_period_end, updated_at
       FROM subscriptions WHERE id = ?`,
    )
    .bind(id)
    .first<SubscriptionRow>();
}

/**
 * Subscription snapshot upsert. An older `updated_at` is ignored. On an equal
 * `updated_at`, terminal statuses (revoked/expired/unpaid) win so a refund or
 * dispute cannot be overwritten by an `active` event sharing its timestamp.
 * Keep the rank expression in sync with `terminalStatusRank` in lib/plan.ts.
 */
export function upsertSubscriptionStatement(
  db: D1Database,
  subscription: SubscriptionRow,
): D1PreparedStatement {
  return db
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
       WHERE excluded.updated_at > subscriptions.updated_at
          OR (
            excluded.updated_at = subscriptions.updated_at
            AND CASE excluded.status
                  WHEN 'revoked' THEN 3
                  WHEN 'expired' THEN 2
                  WHEN 'unpaid' THEN 1
                  ELSE 0
                END
                >=
                CASE subscriptions.status
                  WHEN 'revoked' THEN 3
                  WHEN 'expired' THEN 2
                  WHEN 'unpaid' THEN 1
                  ELSE 0
                END
          )`,
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
    );
}

/**
 * Applies a subscription snapshot only when it is at least as new as the
 * stored row. Returns false when an older event was ignored.
 */
export async function upsertSubscriptionIfNewer(
  db: D1Database,
  subscription: SubscriptionRow,
): Promise<boolean> {
  const result = await upsertSubscriptionStatement(db, subscription).run();
  return (result.meta.changes ?? 0) > 0;
}

/** Idempotency marker used inside the same D1 batch as the state change. */
export function insertWebhookEventStatement(
  db: D1Database,
  id: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO webhook_events (id, received_at) VALUES (?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(id, now);
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
  /** SHA-256 of the desktop's hashed device id; null when omitted. */
  deviceHash: string | null;
}

export async function createDevice(
  db: D1Database,
  input: CreateDeviceInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO devices
         (id, user_id, token_hash, created_at, last_used_at, revoked_at, device_hash)
       VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
    )
    .bind(
      input.id,
      input.userId,
      input.tokenHash,
      input.createdAt,
      input.deviceHash,
    )
    .run();
}

/**
 * Distinct other accounts that have ever used this device signal. Revoked
 * rows still count: signing out must not reset the per-PC free limit.
 */
export async function countOtherUsersOnDevice(
  db: D1Database,
  deviceHash: string,
  userId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT user_id) AS users FROM devices
       WHERE device_hash = ? AND user_id != ?`,
    )
    .bind(deviceHash, userId)
    .first<{ users: number }>();
  return row?.users ?? 0;
}

/** Marks an account as over the per-PC free limit (first time wins). */
export function markFreeBlockedStatement(
  db: D1Database,
  userId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE users SET free_blocked_at = COALESCE(free_blocked_at, ?)
       WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(now, userId);
}

/**
 * Starts the 14-day trial exactly once. The WHERE clause enforces every
 * server-side condition atomically: no prior trial, not free-blocked, and no
 * subscription row has ever existed. A user who never had a desktop sign-in
 * (site-only sign-up) never reaches this statement.
 */
export function startTrialStatement(
  db: D1Database,
  userId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE users SET trial_started_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND trial_started_at IS NULL
         AND free_blocked_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM subscriptions WHERE user_id = users.id
         )`,
    )
    .bind(now, userId);
}

export async function startTrial(
  db: D1Database,
  userId: string,
  now: number,
): Promise<boolean> {
  const result = await startTrialStatement(db, userId, now).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function findDeviceByTokenHash(
  db: D1Database,
  tokenHash: string,
): Promise<DeviceRow | null> {
  return db
    .prepare(
      `SELECT id, user_id, last_used_at, revoked_at, device_hash
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

export function revokeAllDevicesStatement(
  db: D1Database,
  userId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE devices SET revoked_at = ?
       WHERE user_id = ? AND revoked_at IS NULL`,
    )
    .bind(now, userId);
}

/** Revokes every device for a user (decision 10 / Clerk user.deleted). */
export async function revokeAllDevices(
  db: D1Database,
  userId: string,
  now: number,
): Promise<number> {
  const result = await revokeAllDevicesStatement(db, userId, now).run();
  return result.meta.changes ?? 0;
}

/**
 * Soft-deletes a user and clears the PII Ray no longer needs. Subscription
 * and usage rows stay for accounting and fair-use records; `getUser` stops
 * returning the row immediately.
 */
export function markUserDeletedStatement(
  db: D1Database,
  userId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE users
       SET email = NULL, name = NULL, creem_customer_id = NULL, deleted_at = ?
       WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(now, userId);
}

export function deleteUserAuthCodesStatement(
  db: D1Database,
  userId: string,
): D1PreparedStatement {
  return db
    .prepare("DELETE FROM auth_codes WHERE user_id = ?")
    .bind(userId);
}

export interface CleanupGrantRow {
  words: number;
  calls_left: number;
  expires_at: number;
}

/**
 * Every counted STT response earns cleanup capacity (decision 1): words
 * accumulate inside the 15-minute window, calls regenerate up to the cap, and
 * an expired grant restarts from the latest transcription.
 */
export async function grantCleanup(
  db: D1Database,
  userId: string,
  words: number,
  now: number,
  callsPerTranscription: number,
  maxCalls: number,
  ttlSeconds: number,
): Promise<void> {
  if (words <= 0) return;
  await db
    .prepare(
      `INSERT INTO cleanup_grants (user_id, words, calls_left, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         words = CASE
           WHEN cleanup_grants.expires_at <= ? THEN excluded.words
           ELSE cleanup_grants.words + excluded.words
         END,
         calls_left = CASE
           WHEN cleanup_grants.expires_at <= ? THEN excluded.calls_left
           ELSE MIN(cleanup_grants.calls_left + excluded.calls_left, ?)
         END,
         expires_at = excluded.expires_at`,
    )
    .bind(
      userId,
      words,
      callsPerTranscription,
      now + ttlSeconds,
      now,
      now,
      maxCalls,
    )
    .run();
}

/**
 * Atomically consumes one cleanup call and returns the grant's word budget,
 * or null when there is no unexpired grant with calls left.
 */
export async function consumeCleanupGrant(
  db: D1Database,
  userId: string,
  now: number,
): Promise<{ words: number } | null> {
  return db
    .prepare(
      `UPDATE cleanup_grants SET calls_left = calls_left - 1
       WHERE user_id = ? AND calls_left > 0 AND expires_at > ?
       RETURNING words`,
    )
    .bind(userId, now)
    .first<{ words: number }>();
}

/**
 * Acquires a concurrency lease only when the user has fewer than `max`
 * unexpired leases. One SQL statement, so two concurrent requests cannot both
 * pass the count check.
 */
export async function acquireSttLease(
  db: D1Database,
  leaseId: string,
  userId: string,
  now: number,
  expiresAt: number,
  max: number,
): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(
        "DELETE FROM stt_leases WHERE user_id = ? AND expires_at <= ?",
      )
      .bind(userId, now),
    db
      .prepare(
        `INSERT INTO stt_leases (id, user_id, expires_at)
         SELECT ?, ?, ?
         WHERE (
           SELECT COUNT(*) FROM stt_leases
           WHERE user_id = ? AND expires_at > ?
         ) < ?`,
      )
      .bind(leaseId, userId, expiresAt, userId, now, max),
  ]);
  return (results[1]?.meta.changes ?? 0) > 0;
}

export async function releaseSttLease(
  db: D1Database,
  leaseId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM stt_leases WHERE id = ?")
    .bind(leaseId)
    .run();
}

export async function getSttFailures(
  db: D1Database,
  userId: string,
  weekStart: number,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT failures FROM stt_failures WHERE user_id = ? AND week_start = ?",
    )
    .bind(userId, weekStart)
    .first<{ failures: number }>();
  return row?.failures ?? 0;
}

/** Failed transcriptions do not consume words, so count them separately. */
export async function addSttFailure(
  db: D1Database,
  userId: string,
  weekStart: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO stt_failures (user_id, week_start, failures)
       VALUES (?, ?, 1)
       ON CONFLICT(user_id, week_start) DO UPDATE SET
         failures = stt_failures.failures + 1`,
    )
    .bind(userId, weekStart)
    .run();
}
