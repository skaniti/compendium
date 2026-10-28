-- 063_archive_reason_no_pipeline_result.sql
-- Extend pages_archive_reason_check with 'no_pipeline_result': a page row that
-- gets no matching result when process_captures.update_pages_from_response
-- pairs rows with results. Such a row would get no result on a retry either;
-- left 'pending', it made the hourly pending sweep re-process its whole
-- capture (fetch, skip gate, vision) every hour.
-- Same drop/re-add pattern as migrations 011, 041 and 062.

ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_archive_reason_check;
ALTER TABLE pages ADD CONSTRAINT pages_archive_reason_check CHECK (
    archive_reason IS NULL
    OR archive_reason IN (
        'skip_gate', 'manual_exclusion', 'trivial_capture', 'domain_skip',
        'dedup', 'app_chrome_junk', 'placeholder_no_content', 'dedupe_fold',
        'url_skip', 'no_pipeline_result'
    )
);
