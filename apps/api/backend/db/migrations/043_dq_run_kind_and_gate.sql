-- 043_dq_run_kind_and_gate.sql
-- dqBot Tier 2 (docs/project-plans/2026-07-19-131356-dqbot-tier2-role-split/):
-- run_kind distinguishes zero-LLM sensor passes from filing full passes;
-- gate_metrics stores signal-gate/adjudication telemetry; the signal_gate
-- trigger marks gate-fired full runs. Historical rows were all full runs.
ALTER TABLE dq_runs ADD COLUMN IF NOT EXISTS run_kind TEXT NOT NULL DEFAULT 'full';
ALTER TABLE dq_runs ADD COLUMN IF NOT EXISTS gate_metrics JSONB;
ALTER TABLE dq_runs DROP CONSTRAINT IF EXISTS dq_run_kind;
ALTER TABLE dq_runs ADD CONSTRAINT dq_run_kind CHECK (run_kind IN ('full', 'sensor'));
ALTER TABLE dq_runs DROP CONSTRAINT IF EXISTS dq_run_trigger;
ALTER TABLE dq_runs ADD CONSTRAINT dq_run_trigger
  CHECK (trigger IN ('manual', 'schedule', 'recluster_event', 'signal_gate'));
