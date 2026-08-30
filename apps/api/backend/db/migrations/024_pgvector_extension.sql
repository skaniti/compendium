-- 024_pgvector_extension.sql
-- Idempotent enabling of the pgvector extension.
--
-- Local docker-compose uses the pgvector/pgvector:pg16 image which has
-- the extension pre-loaded; Render's managed Postgres does NOT, and a
-- first-time deploy will fail on any embedding-typed column unless this
-- runs first. CREATE EXTENSION IF NOT EXISTS makes this safe to re-run.

CREATE EXTENSION IF NOT EXISTS vector;
