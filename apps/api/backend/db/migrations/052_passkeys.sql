-- 052_passkeys.sql
-- WebAuthn passkeys for the owner account (owner-passkeys, 2026-10-11).
-- Same conventions as 049: rows go with their user, no RLS, used or revoked
-- rows stay for the record. Enrollment tokens and challenges are stored as
-- SHA-256 hex, break-glass codes as bcrypt hashes; never the raw values.

ALTER TABLE users ADD COLUMN IF NOT EXISTS webauthn_user_handle BYTEA UNIQUE;

CREATE TABLE IF NOT EXISTS passkey_credentials (
    id              BIGSERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id   BYTEA NOT NULL UNIQUE,
    public_key      BYTEA NOT NULL,
    sign_count      BIGINT NOT NULL DEFAULT 0,
    transports      TEXT[] NOT NULL DEFAULT '{}',
    aaguid          TEXT,
    backup_eligible BOOLEAN NOT NULL DEFAULT FALSE,
    backed_up       BOOLEAN NOT NULL DEFAULT FALSE,
    label           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user ON passkey_credentials (user_id);

CREATE TABLE IF NOT EXISTS passkey_enrollments (
    id          BIGSERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    label       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
    id             BIGSERIAL PRIMARY KEY,
    purpose        TEXT NOT NULL CHECK (purpose IN ('register', 'authenticate')),
    challenge_hash TEXT NOT NULL UNIQUE,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    enrollment_id  BIGINT REFERENCES passkey_enrollments(id) ON DELETE CASCADE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at     TIMESTAMPTZ NOT NULL,
    consumed_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS break_glass_codes (
    id         BIGSERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_break_glass_codes_user ON break_glass_codes (user_id);

-- A break-glass session stays a plain (not remembered) session through every
-- refresh rotation; auth_service.rotate_refresh_token carries this forward.
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS break_glass BOOLEAN NOT NULL DEFAULT FALSE;
