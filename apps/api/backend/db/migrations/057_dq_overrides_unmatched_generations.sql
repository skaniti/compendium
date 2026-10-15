-- 057_dq_overrides_unmatched_generations.sql
-- dqBot U4: durable override identity. unmatched_generations counts
-- consecutive recluster generations in which an active override matched no
-- cluster (reset to 0 when applied); overrides unmatched for
-- DQ_OVERRIDE_RETIRE_AFTER generations are auto-retired with retired_reason.
-- Touches only dq_overrides (2026-10). Runs from apps/api like every production
-- migration; the explorer worker reads these columns through the API only.
ALTER TABLE dq_overrides ADD COLUMN IF NOT EXISTS unmatched_generations INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dq_overrides ADD COLUMN IF NOT EXISTS retired_reason TEXT;
