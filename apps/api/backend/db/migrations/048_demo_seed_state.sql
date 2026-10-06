-- 048_demo_seed_state.sql
-- Records which demo seed (sha256 of demo_seed.json.gz + the augment file) is
-- loaded for the demo account, so scripts/demo/load_demo_seed.py --replace
-- can no-op when nothing changed (tailnet-owner-demo-split, 2026-10-06).
-- One row per demo account; dropped with the user.

CREATE TABLE IF NOT EXISTS demo_seed_state (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    seed_sha256 TEXT NOT NULL,
    loaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
