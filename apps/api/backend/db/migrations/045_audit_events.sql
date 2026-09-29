-- 045_audit_events.sql
-- Server audit events (the 2026-09-28 server-audit-and-ops-journal plan,
-- spec 4.1): an append-only record of security-relevant actions -- key
-- rotation, logins, refresh-token reuse, view-as, role/password changes.
-- `client_hash` is HMAC-SHA256(client_key, JWT_SECRET_KEY) truncated to 16
-- hex chars, never the address itself. `origin_class` is tailnet / public
-- / cli / unknown. `detail` may never hold a key, token, password, or an
-- unverified anonymous identifier (audit_repo.record redacts secret-shaped
-- values as a belt-and-braces guard).
-- No RLS: the API connects as the table owner, the read endpoint gates on
-- admin, and claude_ro reads via its default SELECT grant.
-- migrate.py records each applied migration's filename stem in
-- schema_migrations and skips versions already there, so IF NOT EXISTS
-- here is defence-in-depth -- same convention as 044.

CREATE TABLE IF NOT EXISTS audit_events (
    id              BIGSERIAL PRIMARY KEY,
    at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    event           TEXT NOT NULL CHECK (event IN (
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
        'user.password_set'
    )),
    actor_user_id   INTEGER NULL,
    subject_user_id INTEGER NULL,
    origin_class    TEXT NOT NULL
        CHECK (origin_class IN ('tailnet', 'public', 'cli', 'unknown')),
    client_hash     TEXT NULL,
    detail          JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_events_at
    ON audit_events (at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_event_at
    ON audit_events (event, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_subject_at
    ON audit_events (subject_user_id, at DESC);
