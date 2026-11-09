-- A second Pro-to-Starter transition in the same week must retake the Starter
-- baseline: the first snapshot only covers the Pro usage before it. Record
-- which Pro end the snapshot was taken for so a later transition in the same
-- week replaces the stale baseline instead of reusing it.
ALTER TABLE users ADD COLUMN starter_baseline_pro_ended_at INTEGER;
