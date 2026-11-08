-- The Starter allowance starts when a no-card trial ends.
--
-- `usage_weeks` holds one aggregate per week, so a trial that expires mid-week
-- leaves its words/audio in the same row as post-trial Starter usage. The
-- first post-trial request snapshots the week's totals here; Starter quota
-- then counts only the difference. `starter_baseline_week` names the week the
-- snapshot belongs to, so later weeks are unaffected.
ALTER TABLE users ADD COLUMN starter_baseline_week INTEGER;
ALTER TABLE users ADD COLUMN starter_baseline_words INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN starter_baseline_audio_seconds INTEGER NOT NULL DEFAULT 0;
