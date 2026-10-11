-- 053_audit_passkey_events.sql
-- Adds the owner-passkeys events to the audit_events allow-list (2026-10-11).
-- Same drop-and-recreate shape as 050/051: audit_repo.record swallows an
-- IntegrityError, so without this the new events would be silently dropped.

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
    'auth.demo_entry.failed',
    'auth.passkey.enroll_link_issued',
    'auth.passkey.registered',
    'auth.passkey.register_failed',
    'auth.passkey.revoked',
    'auth.break_glass.issued',
    'auth.trusted_browser.revoked',
    'auth.sessions.ended'
));
