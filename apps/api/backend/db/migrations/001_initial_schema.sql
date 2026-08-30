-- 001_initial_schema.sql
-- Normalized 3NF schema for traversal-based discovery (9 tables).

-- 1. users
CREATE TABLE users (
    id              SERIAL PRIMARY KEY,
    email           TEXT UNIQUE NOT NULL,
    name            TEXT,
    api_key_hash    TEXT UNIQUE NOT NULL,
    api_key_prefix  TEXT,
    last_used_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 2. captures
CREATE TABLE captures (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    capture_id  TEXT UNIQUE NOT NULL,
    source      TEXT NOT NULL,
    started_at  TIMESTAMPTZ NOT NULL,
    ended_at    TIMESTAMPTZ NOT NULL,
    is_trivial  BOOLEAN DEFAULT FALSE,
    title       TEXT,
    mini_summary TEXT,
    events      JSONB DEFAULT '[]',
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT captures_source_check CHECK (source IN ('desktop_active','desktop_passive','mobile_passive')),
    CONSTRAINT captures_time_order CHECK (ended_at >= started_at),
    CONSTRAINT capture_id_length CHECK (length(capture_id) <= 64)
);
CREATE INDEX idx_captures_user ON captures(user_id);

-- 3. page_content (created before pages due to FK)
CREATE TABLE page_content (
    id              SERIAL PRIMARY KEY,
    url             TEXT NOT NULL,
    domain          TEXT,
    extracted_text  TEXT,
    fetched_content JSONB,
    content_summary TEXT,
    tool_selected   TEXT,
    fetched_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX page_content_url_key ON page_content (md5(url));
CREATE INDEX idx_page_content_url_hash ON page_content USING hash (url);
CREATE INDEX idx_page_content_domain ON page_content(domain);

-- 4. pages
CREATE TABLE pages (
    id                    BIGSERIAL PRIMARY KEY,
    capture_id            INTEGER NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
    page_content_id       INTEGER REFERENCES page_content(id),
    url                   TEXT NOT NULL,
    title                 TEXT,
    domain                TEXT,
    dwell_time_seconds    INTEGER,
    visited_at            TIMESTAMPTZ,
    transition_type       TEXT,
    transition_qualifiers JSONB,
    is_tracked_domain     BOOLEAN DEFAULT TRUE,
    extracted_text        TEXT,
    status                TEXT NOT NULL DEFAULT 'pending',
    archive_reason        TEXT,
    skip_reasoning        TEXT,
    processing_depth      TEXT,
    processing_metadata   JSONB,
    content_summary       TEXT,
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT pages_status_check CHECK (status IN ('pending','active','archived')),
    CONSTRAINT pages_archive_reason_check CHECK (
        archive_reason IS NULL
        OR archive_reason IN ('skip_gate','manual_exclusion','trivial_capture')
    ),
    CONSTRAINT pages_processing_depth_check CHECK (
        processing_depth IS NULL
        OR processing_depth IN ('processed','surface','full','skipped')
    )
);
CREATE INDEX idx_pages_capture ON pages(capture_id);
CREATE INDEX idx_pages_status ON pages(status);
CREATE INDEX idx_pages_domain ON pages(domain);
CREATE INDEX idx_pages_visited_at ON pages(visited_at);
CREATE INDEX idx_pages_active_capture ON pages(capture_id) WHERE status = 'active';
CREATE INDEX idx_pages_content ON pages(page_content_id);

-- 5. recluster_runs (created before clusters due to FK)
CREATE TABLE recluster_runs (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'running',
    started_at      TIMESTAMPTZ DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    cluster_count   INTEGER,
    noise_count     INTEGER,
    naming_cost     REAL,
    elapsed_seconds REAL,
    CONSTRAINT recluster_status_check CHECK (status IN ('running','completed','failed'))
);
CREATE INDEX idx_recluster_runs_user ON recluster_runs(user_id);

-- 6. clusters
CREATE TABLE clusters (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cluster_slug    TEXT NOT NULL,
    cluster_name    TEXT NOT NULL,
    recluster_run   INTEGER NOT NULL REFERENCES recluster_runs(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, recluster_run, cluster_slug)
);
CREATE INDEX idx_clusters_user ON clusters(user_id);
CREATE INDEX idx_clusters_recluster ON clusters(user_id, recluster_run);

-- 7. page_clusters (join table)
CREATE TABLE page_clusters (
    page_id     BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    cluster_id  INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    PRIMARY KEY (page_id, cluster_id)
);
CREATE INDEX idx_page_clusters_cluster ON page_clusters(cluster_id);

-- 8. cluster_edges
CREATE TABLE cluster_edges (
    id              SERIAL PRIMARY KEY,
    source_cluster  INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    target_cluster  INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    weight          REAL NOT NULL,
    recluster_run   INTEGER NOT NULL REFERENCES recluster_runs(id) ON DELETE CASCADE,
    UNIQUE (source_cluster, target_cluster, recluster_run),
    CONSTRAINT cluster_edges_weight_range CHECK (weight >= 0 AND weight <= 1),
    CONSTRAINT cluster_edges_no_self_loop CHECK (source_cluster != target_cluster)
);
CREATE INDEX idx_cluster_edges_source ON cluster_edges(source_cluster);
CREATE INDEX idx_cluster_edges_target ON cluster_edges(target_cluster);

-- 9. graph_cache
CREATE TABLE graph_cache (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
    graph_data  JSONB NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
