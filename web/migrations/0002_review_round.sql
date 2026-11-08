-- Review-round hardening.
-- Timestamps are unix seconds unless a comment says otherwise.

-- Cleanup grants: earned by a counted transcription, consumed by cleanup calls.
CREATE TABLE cleanup_grants (
  user_id TEXT PRIMARY KEY,
  words INTEGER NOT NULL,
  calls_left INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_cleanup_grants_expires ON cleanup_grants (expires_at);

-- Per-user STT concurrency leases (at most two in flight per user).
CREATE TABLE stt_leases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_stt_leases_user ON stt_leases (user_id);
CREATE INDEX idx_stt_leases_expires ON stt_leases (expires_at);

-- Weekly failed-transcription counts. Failed STT attempts are otherwise free,
-- so an abusive user is cut off after a generous weekly number of failures.
CREATE TABLE stt_failures (
  user_id TEXT NOT NULL,
  week_start INTEGER NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, week_start)
);

-- Soft-delete marker for Clerk `user.deleted`. Deleted users can no longer
-- authenticate with a device token and are not recreated by Clerk auth.
ALTER TABLE users ADD COLUMN deleted_at INTEGER;

-- One Creem customer may map to at most one user. Webhooks map by
-- metadata.user_id first and creem_customer_id second; email is never used.
DROP INDEX IF EXISTS idx_users_creem_customer;
CREATE UNIQUE INDEX idx_users_creem_customer_unique
  ON users (creem_customer_id)
  WHERE creem_customer_id IS NOT NULL;
