-- 028_dq_vocab_and_receipts.sql
-- Vocab tightening + receipts-first dqBot schema.
--
-- Two changes that ship together because they share the dq_observations write
-- path:
--   1. dq_vocab_issue_types -- per-user registry of canonical/proposed/rejected
--      issue_type labels. The supersession-on-re-detection logic (added
--      2026-04-26) keys off (user_id, entity_type, entity_id, issue_type);
--      near-synonyms (e.g. coherence_drift vs cluster_coherence_drift) break
--      that dedup. Cosine-similarity gate routes new findings to the closest
--      canonical label so the same underlying issue stops appearing as two
--      separate findings.
--   2. Receipt columns on dq_observations -- evidence/reasoning/ambiguities
--      JSONB plus a stored SELECT (sql_query + status/n_rows) executed at
--      write time. Surfaces dqbot's full reasoning trail to the user instead
--      of just the conclusion. See spec for layered-receipts design intent.
--
-- The defensive check (step 6) runs before the FK creation so a partial
-- bootstrap fails loudly within the transaction instead of leaving a
-- half-applied state. ON CONFLICT DO NOTHING keeps both INSERT steps
-- idempotent.
--
-- Design spec: docs/project-plans/_completed/2026-05-01-194021-dq-vocab-receipts/spec.md
-- Implementation plan: docs/project-plans/_completed/2026-05-01-194021-dq-vocab-receipts/plan.md

-- == 1. Vocab table ==================================================
CREATE TABLE IF NOT EXISTS dq_vocab_issue_types (
    user_id                  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    issue_type               TEXT NOT NULL,
    description              TEXT,
    description_embedding    VECTOR(384),
    status                   TEXT NOT NULL DEFAULT 'proposed'
                             CHECK (status IN ('canonical', 'proposed', 'rejected')),
    aliased_to               TEXT,
    proposal_rationale       TEXT,
    n_proposals              INTEGER NOT NULL DEFAULT 1,
    last_proposed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_proposing_run_id    INTEGER REFERENCES dq_runs(id) ON DELETE SET NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    canonicalized_at         TIMESTAMPTZ,
    canonicalized_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (user_id, issue_type),
    CONSTRAINT canonical_requires_description
        CHECK (status <> 'canonical'
               OR (description IS NOT NULL AND description_embedding IS NOT NULL)),
    CONSTRAINT alias_requires_rejected
        CHECK (aliased_to IS NULL OR status = 'rejected'),
    CONSTRAINT alias_target_self
        FOREIGN KEY (user_id, aliased_to)
        REFERENCES dq_vocab_issue_types(user_id, issue_type)
        DEFERRABLE INITIALLY DEFERRED
);

-- == 2. RLS (matches pattern from 019_dq_helper_tables.sql) ==========
ALTER TABLE dq_vocab_issue_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dq_vocab_select ON dq_vocab_issue_types;
DROP POLICY IF EXISTS dq_vocab_insert ON dq_vocab_issue_types;
DROP POLICY IF EXISTS dq_vocab_update ON dq_vocab_issue_types;

CREATE POLICY dq_vocab_select ON dq_vocab_issue_types FOR SELECT
    USING (user_id = current_setting('app.current_user_id', true)::INTEGER);
CREATE POLICY dq_vocab_insert ON dq_vocab_issue_types FOR INSERT
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::INTEGER);
CREATE POLICY dq_vocab_update ON dq_vocab_issue_types FOR UPDATE
    USING (user_id = current_setting('app.current_user_id', true)::INTEGER);

-- == 3. Read-only role for SQL receipts ==============================
-- dqbot's pre-generated SELECT statements run as this role. SELECT-only
-- privileges + 5s statement_timeout are the actual fence; the in-process
-- sqlparse validator is a courtesy filter.
DO $$ BEGIN
    CREATE ROLE dq_bot_readonly NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Note: "supercluster" is a string column on clusters, not a separate table.
-- The receipts allowlist (in dq_sql_receipt.py) must mirror this set.
GRANT SELECT ON
    pages, clusters, page_clusters, annotations, captures,
    dq_observations, dq_recommendations, dq_runs, dq_run_events,
    dq_vocab_issue_types
TO dq_bot_readonly;

-- Ensure the role can read the schema (needed for column metadata).
GRANT USAGE ON SCHEMA public TO dq_bot_readonly;

ALTER ROLE dq_bot_readonly SET statement_timeout = '5s';

-- == 4. Receipt + SQL columns on dq_observations =====================
ALTER TABLE dq_observations
    ADD COLUMN IF NOT EXISTS evidence    JSONB NOT NULL DEFAULT '{"items": []}'::jsonb,
    ADD COLUMN IF NOT EXISTS reasoning   JSONB NOT NULL DEFAULT '{"steps": []}'::jsonb,
    ADD COLUMN IF NOT EXISTS ambiguities JSONB NOT NULL DEFAULT '{"items": []}'::jsonb,
    ADD COLUMN IF NOT EXISTS proposed_issue_type TEXT,
    ADD COLUMN IF NOT EXISTS sql_query              TEXT,
    ADD COLUMN IF NOT EXISTS sql_query_description  TEXT,
    ADD COLUMN IF NOT EXISTS sql_query_executed_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS sql_query_n_rows       INTEGER,
    ADD COLUMN IF NOT EXISTS sql_query_error_text   TEXT;

-- Use a separate ALTER for the CHECK so re-runs don't fail on the constraint
-- already existing.
DO $$ BEGIN
    ALTER TABLE dq_observations
        ADD COLUMN sql_query_status TEXT
        CHECK (sql_query_status IS NULL OR sql_query_status IN ('ok','error','empty'));
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- == 5. Bootstrap vocab from existing distinct values ================
INSERT INTO dq_vocab_issue_types
    (user_id, issue_type, status, n_proposals, last_proposed_at, created_at)
SELECT DISTINCT
    o.user_id, o.issue_type, 'proposed', 1, NOW(), NOW()
FROM dq_observations o
WHERE o.issue_type IS NOT NULL
ON CONFLICT (user_id, issue_type) DO NOTHING;

-- Seed deterministic-investigator constants per user (n_proposals=0 marks
-- entries that were seeded rather than observed). Overlap with bootstrap is
-- handled by ON CONFLICT DO NOTHING.
INSERT INTO dq_vocab_issue_types
    (user_id, issue_type, status, n_proposals, last_proposed_at)
SELECT u.id, c.issue_type, 'proposed', 0, NOW()
FROM users u
CROSS JOIN (VALUES
    ('cluster_coherence_drift'),
    ('dedup_escapees'),
    ('domain_silo'),
    ('supercluster_drift'),
    ('reversal_pattern')
) AS c(issue_type)
ON CONFLICT (user_id, issue_type) DO NOTHING;

-- == 6. Defensive check: every existing observation issue_type ==
-- ==    must be in vocab (must run before FK creation) ==========
DO $$
DECLARE missing_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO missing_count
    FROM dq_observations o
    LEFT JOIN dq_vocab_issue_types v
      ON o.user_id = v.user_id AND o.issue_type = v.issue_type
    WHERE o.issue_type IS NOT NULL AND v.issue_type IS NULL;

    IF missing_count > 0 THEN
        RAISE EXCEPTION
          'Bootstrap incomplete: % observation issue_types missing from vocab', missing_count;
    END IF;
END $$;

-- == 7. FK constraint (write-time only; existing rows already covered) ==
ALTER TABLE dq_observations
    DROP CONSTRAINT IF EXISTS dq_obs_issue_type_fk;

ALTER TABLE dq_observations
    ADD CONSTRAINT dq_obs_issue_type_fk
    FOREIGN KEY (user_id, issue_type)
    REFERENCES dq_vocab_issue_types(user_id, issue_type)
    ON DELETE RESTRICT;
