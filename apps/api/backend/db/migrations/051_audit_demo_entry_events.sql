-- 051_audit_demo_entry_events.sql
-- Adds the one-click public demo entry events to the audit_events allow-list
-- (demo-one-click-entry, 2026-10-09). Same drop-and-recreate shape as 050:
-- the CHECK was declared inline in 045, so it is named
-- audit_events_event_check. audit_repo.record swallows an IntegrityError, so
-- without this the new events would be silently dropped.

ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_event_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_event_check CHECK (event IN (
    'api_key.rotated',
    'api_key.auth_failed',
    'auth.login.ok',
    'auth.login.failed',
    'auth.refresh.ok',
    'auth.refresh.reuse_detected',
    'auth.logout',
    'auth.viewas.start',
    'auth.viewas.denied',
    'auth.viewas.stop',
    'user.role_set',
    'user.password_set',
    'auth.trusted_browser.added',
    'auth.demo_entry.ok',
    'auth.demo_entry.failed'
));
