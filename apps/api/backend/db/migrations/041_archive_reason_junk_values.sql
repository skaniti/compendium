-- 041_archive_reason_junk_values.sql
-- Extend pages_archive_reason_check with the three archive reasons introduced
-- by the 2026-07-17 dq-queue executive-triage sweep:
--   app_chrome_junk        -- claude.ai app-chrome shells (dq_junk_cleanup.py
--                             purge + Stage-0 denylist keeps new ones out)
--   placeholder_no_content -- 'Page browsed outside API tool scope' stubs
--                             (bulk purge + auto-archive at persist time in
--                             process_captures._persist_single_page)
--   dedupe_fold            -- redundant rows of verified duplicate groups
--                             (explicit id list in dq_junk_cleanup.py)
-- Same drop/re-add pattern as migration 011 (which added 'dedup').
-- Design: docs/project-plans/2026-07-17-120945-dq-queue-executive-triage/

ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_archive_reason_check;
ALTER TABLE pages ADD CONSTRAINT pages_archive_reason_check CHECK (
    archive_reason IS NULL
    OR archive_reason IN (
        'skip_gate', 'manual_exclusion', 'trivial_capture', 'domain_skip',
        'dedup', 'app_chrome_junk', 'placeholder_no_content', 'dedupe_fold'
    )
);
