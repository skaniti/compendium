-- 049_trusted_browsers.sql
-- Browsers the owner has trusted for automatic sign-in over the tailnet
-- (tailnet-passwordless-login, 2026-10-09). The browser keeps the raw
-- token in an HttpOnly cookie; only its SHA-256 (hex) is stored here.
-- Revoked rows stay for the audit trail; rows go with their user.

CREATE TABLE IF NOT EXISTS trusted_browsers (
    id           BIGSERIAL PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    label        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_trusted_browsers_user ON trusted_browsers (user_id);
