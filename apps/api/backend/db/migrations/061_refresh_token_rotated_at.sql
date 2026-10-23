-- 061_refresh_token_rotated_at.sql
-- Refresh-token reuse grace window (backlog #43). auth_service.rotate_refresh_token
-- treated every replay of an already-revoked refresh token as theft and revoked
-- every session and trusted browser of the account, which also fired on the
-- owner's own devices when two refreshes raced (tabs waking together, a retry
-- after a lost response). To tell that race from theft the row needs to say WHEN
-- it was revoked by a rotation, as opposed to by logout, revoke-all or expiry.
--
-- rotated_at is set only by rotation (auth_repo.mark_refresh_token_rotated), at
-- the same instant as revoked_at. NULL means "not revoked by a rotation", so a
-- logged-out or revoke-all'd token can never be replayed into a new session
-- inside the grace window. Rows revoked before this migration stay NULL: no
-- grace for them, today's behaviour. No index: the column is only read on a
-- row already found by token_hash, and by the user-scoped check
-- (idx_refresh_tokens_user) when a replay lands inside the window.

ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ;

COMMENT ON COLUMN refresh_tokens.rotated_at IS
    'When this token was revoked by a rotation (same instant as revoked_at). '
    'NULL = not revoked by a rotation (logout, revoke-all, expiry, or revoked '
    'before migration 061). A replay within refresh_reuse_grace_seconds of '
    'rotated_at is treated as a benign race, not theft.';
