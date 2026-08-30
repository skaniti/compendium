-- 006_jwt_auth_and_preferences.sql
-- JWT authentication and user preferences.
--
-- Adds password_hash for login-based auth (coexists with API key auth).
-- Adds preferences JSONB for user settings (theme, UI state).
-- Creates refresh_tokens table for JWT refresh token rotation.

-- Password hash for JWT login (NULL for API-key-only users like the extension)
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- User preferences (theme selection, UI settings)
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}';

-- Refresh token tracking (for JWT rotation)
CREATE TABLE refresh_tokens (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    revoked_at  TIMESTAMPTZ
);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);

-- Cleanup index: find expired/revoked tokens for periodic pruning
CREATE INDEX idx_refresh_tokens_cleanup ON refresh_tokens(expires_at)
    WHERE revoked_at IS NULL;

ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY refresh_tokens_isolation ON refresh_tokens
    USING (user_id = current_setting('app.current_user_id', true)::INTEGER);
