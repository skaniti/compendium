-- 062_archive_reason_url_skip.sql
-- Extend pages_archive_reason_check with 'url_skip': Stage-0 URL-pattern skips
-- (main.process_capture's _is_skip_url pre-filter, summary "URL pattern
-- skipped: ...") get their own archive reason instead of being stored as
-- 'skip_gate'. They never reach the LLM gate, so lumping them in with its
-- decisions skewed the gate's counts, the archive-validation sample and
-- anything else keyed on archive_reason. 'domain_skip' stays the Stage-0
-- domain-denylist tier; the Pipeline flow splits the two by this column.
-- Schema only: rows already stored as 'skip_gate' are relabelled by
-- backend/scripts/backfill_url_skip_reason.py (dry run by default).
-- Same drop/re-add pattern as migrations 011 and 041.

ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_archive_reason_check;
ALTER TABLE pages ADD CONSTRAINT pages_archive_reason_check CHECK (
    archive_reason IS NULL
    OR archive_reason IN (
        'skip_gate', 'manual_exclusion', 'trivial_capture', 'domain_skip',
        'dedup', 'app_chrome_junk', 'placeholder_no_content', 'dedupe_fold',
        'url_skip'
    )
);
