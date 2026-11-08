-- Audio metering. AssemblyAI bills audio time, not words, so the Worker
-- counts the bytes streamed to it (PCM16 mono 16 kHz = 32,000 bytes/s) into
-- the same weekly usage row. Existing rows start at zero.
ALTER TABLE usage_weeks ADD COLUMN audio_seconds INTEGER NOT NULL DEFAULT 0;
