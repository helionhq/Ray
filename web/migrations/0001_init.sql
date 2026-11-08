-- Ray web API: initial D1 schema.
-- Timestamps are unix seconds unless a comment says otherwise.
-- `subscriptions.updated_at` is unix milliseconds so same-second webhook
-- deliveries can still be ordered correctly.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  creem_customer_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_users_creem_customer ON users (creem_customer_id);
CREATE INDEX idx_users_email ON users (email);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX idx_devices_user ON devices (user_id);
CREATE INDEX idx_devices_token_hash ON devices (token_hash);

CREATE TABLE auth_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  challenge TEXT NOT NULL,
  state TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX idx_auth_codes_expires ON auth_codes (expires_at);
CREATE INDEX idx_auth_codes_user ON auth_codes (user_id);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  product_id TEXT,
  interval TEXT,
  status TEXT NOT NULL,
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_subscriptions_user ON subscriptions (user_id);
CREATE INDEX idx_subscriptions_status ON subscriptions (status);

CREATE TABLE usage_weeks (
  user_id TEXT NOT NULL,
  week_start INTEGER NOT NULL,
  words INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, week_start)
);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);

CREATE INDEX idx_webhook_events_received ON webhook_events (received_at);
