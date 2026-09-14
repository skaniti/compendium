-- 033: device/browser provenance on captures
-- Spec: the 2026-06-10 capture-provenance plan (private)
-- Nullable + free-form by design; client_meta.inferred=true marks era-backfilled
-- rows so observed and inferred provenance stay distinguishable.
ALTER TABLE captures ADD COLUMN IF NOT EXISTS device_label text;
ALTER TABLE captures ADD COLUMN IF NOT EXISTS client_meta jsonb;
