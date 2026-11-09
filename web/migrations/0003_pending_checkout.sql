-- One in-flight Creem checkout per user. It is written atomically before the
-- checkout URL is returned and cleared by the subscription webhook (or after
-- the TTL), so a delayed webhook cannot lead to a second subscription and
-- charge from another tab or device.
CREATE TABLE pending_checkouts (
  user_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
