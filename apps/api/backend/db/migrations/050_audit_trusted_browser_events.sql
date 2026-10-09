-- 050_audit_trusted_browser_events.sql
-- Adds 'auth.trusted_browser.added' to the audit_events event allow-list
-- (tailnet-passwordless-login, 2026-10-09). 045 declared the CHECK inline,
-- so Postgres named it audit_events_event_check; drop and re-create it with
-- the original 12 events plus the new one. audit_repo.record swallows an
-- IntegrityError, so without this the new event would be silently dropped.

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
    'auth.trusted_browser.added'
));
