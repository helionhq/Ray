-- 14-day no-card Pro trial and the per-PC free-account limit.
--
-- `trial_started_at` is set once, on the user's first successful desktop
-- sign-in, and only when the account has never had a subscription, is not
-- free-blocked, and the desktop supplied a valid device id.
--
-- `free_blocked_at` marks an account that would be the fourth (or later)
-- distinct Ray account seen on one PC. It grants no trial and blocks free STT.
ALTER TABLE users ADD COLUMN trial_started_at INTEGER;
ALTER TABLE users ADD COLUMN free_blocked_at INTEGER;

-- SHA-256 of the desktop's already one-way hashed device id. The raw
-- MachineGuid is never sent to the Worker; this lets the Worker count distinct
-- accounts per PC without storing anything reversible to hardware.
ALTER TABLE devices ADD COLUMN device_hash TEXT;
CREATE INDEX idx_devices_device_hash ON devices (device_hash);
