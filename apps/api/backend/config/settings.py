"""Application settings and configuration."""

import logging
from functools import lru_cache
from pathlib import Path
from typing import Optional

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_logger = logging.getLogger(__name__)


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=(".env", str(Path.home() / ".secrets")),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ==========================================================================
    # Environment
    # ==========================================================================
    environment: str = "development"
    log_level: str = "INFO"
    # When non-empty, the API also writes its JSON log lines to this file
    # (0644, reopened on rotation). Empty = stdout only.
    log_file_path: str = ""
    api_host: str = "0.0.0.0"
    api_port: int = 8001

    # ==========================================================================
    # Database
    # ==========================================================================
    database_url: str = "postgresql://tbd:tbd_local@localhost:5433/traversal_discovery"
    test_database_url: str = "postgresql://tbd:tbd_local@localhost:5433/traversal_discovery_test"

    # ==========================================================================
    # URLs & CORS
    # ==========================================================================
    frontend_url: str = "http://localhost:8050"
    cors_origins: str = "*"

    # ==========================================================================
    # LLM API Keys
    # ==========================================================================
    openai_api_key: Optional[str] = None
    # Separate key used ONLY for demo-role agent queries, so the public demo
    # credential's spend can be capped at the provider (an OpenAI *project*
    # with its own budget limit) without bounding the owner's own usage on
    # the same deployment. Optional: when unset, demo falls back to
    # openai_api_key and behaviour is exactly as before.
    openai_api_key_demo: Optional[str] = None
    anthropic_api_key: Optional[str] = None
    hf_token: Optional[str] = None  # For HuggingFace gated model downloads

    # ==========================================================================
    # Content Fetching APIs
    # ==========================================================================
    youtube_api_key: Optional[str] = None

    # ==========================================================================
    # LangSmith Monitoring
    # ==========================================================================
    langchain_tracing_v2: bool = False
    langchain_api_key: Optional[str] = None
    langchain_project: str = "compendium"

    # ==========================================================================
    # JWT Authentication
    # ==========================================================================
    jwt_secret_key: str = "change-me-in-production"
    jwt_access_token_expire_minutes: int = 15
    jwt_refresh_token_expire_days: int = 7
    # Session expiry tuning (the 2026-09-09 session-expiry-tuning plan
    # (private), spec D1, amended 2026-09-10): per-role
    # session policy. A "remembered" session (90-day refresh token, no idle
    # lapse; never available to the demo role) is granted server-side based
    # on the ingress path the request arrived over, NOT a client opt-in --
    # see the ingress settings below and ``auth_service.ingress_trusted``.
    # Demo gets a longer idle window (public read-only, no long-refresh
    # path); default is unchanged from the historical 60-minute idle
    # behavior.
    jwt_refresh_token_expire_days_remembered: int = 90
    session_idle_minutes: int = 60
    session_idle_minutes_demo: int = 720
    session_idle_minutes_remembered: int = 0
    # Amendment 2026-09-10 (spec D1 tailnet-trust rewrite): Caddy overwrites
    # this header on both loopback listeners before proxying to the app --
    # ``tailnet`` on the tailscale-serve listener (:8081), ``public`` on the
    # Cloudflare Tunnel listener (:8080) -- so a public caller cannot forge
    # it (see spec.md's "Tailnet trust" paragraph and D6). The API trusts
    # only this header; anything else (including an explicit "public")
    # means the request is NOT tailnet-trusted.
    session_ingress_header: str = "X-Compendium-Ingress"
    session_ingress_trusted_value: str = "tailnet"
    # Dev-only: local development has no Caddy in front of it, so the header
    # is always absent. Setting this True treats an ABSENT header as
    # trusted so a solo local dev session behaves like a tailnet session.
    # Refused at startup in production -- see _check_production_secrets --
    # because it would make every public caller implicitly trusted.
    session_trust_missing_ingress: bool = False
    # Task 7e (post-flip-closeout): the api container is reached through a
    # `127.0.0.1:8001:8000` docker port map, so uvicorn's peer address is
    # always the docker bridge gateway for every request -- one rate-limit
    # bucket shared by every caller regardless of who they actually are.
    # Both knobs below are inert until explicitly set, so this lands safely
    # ahead of any env configuration; see backend/api/rate_limit_key.py for
    # the precedence they feed into.
    rate_limit_trust_cf_header: bool = False
    """When True, trust the `CF-Connecting-IP` header for rate-limit keying.
    Only safe when Cloudflare is the sole ingress to the api and overwrites
    this header on every request (the production tunnel deployment) --
    production sets this to 1. Env var ``RATE_LIMIT_TRUST_CF_HEADER``."""

    proxy_shared_secret: str = ""
    """Shared secret the Next.js proxy (apps/web) presents via
    `X-Compendium-Proxy-Secret` to attest the `X-Compendium-Client-Ip` header
    it also sends. Empty (default) means the proxy-attested address is never
    trusted, regardless of what either header claims. Env var
    ``PROXY_SHARED_SECRET``."""
    # Development only: when True (the default), requests that carry no token
    # resolve to the default dev user so a fresh checkout works without a
    # login. Set DEV_AUTH_BYPASS=0 to exercise the real login, refresh and
    # expiry paths locally; ignored outside environment=development, where the
    # bypass never applies.
    dev_auth_bypass: bool = True

    # ==========================================================================
    # User Identity (dev / bootstrap)
    # ==========================================================================
    # These mirror env vars consumed by ``get_default_user_id`` in
    # backend/api/main.py. Historically that function read os.environ
    # directly, which silently fell through to ``dev@localhost`` whenever
    # the shell launching the Python process didn't propagate .env --
    # producing "empty graph" symptoms even when .env was correctly
    # configured. Reading via Settings closes that gap (pydantic loads
    # .env into the Settings object regardless of os.environ state).
    bootstrap_email: Optional[str] = None
    dev_default_user_email: Optional[str] = None

    # ==========================================================================
    # Model Configuration
    # ==========================================================================
    default_summary_model: str = "gpt-3.5-turbo"
    default_inference_model: str = "gpt-4o"
    default_embedding_model: str = "text-embedding-3-small"

    # ==========================================================================
    # Clustering Configuration
    # ==========================================================================
    clustering_embedding_model: str = "all-MiniLM-L6-v2"
    """Embedding model for the CLUSTERING pipeline only (RAG chunk embeddings
    are unaffected). Default keeps the legacy local SBERT path byte-identical.
    A value starting with ``text-embedding-`` activates the gated candidate
    path: OpenAI embeddings + text recipe v2 (one register, no silent
    truncation), cached in ``clustering_embeddings`` keyed by
    ``<model>@<text-contract>``, with cost events recorded as
    ``clustering_embedding``. Tunable via env var
    ``CLUSTERING_EMBEDDING_MODEL``. Introduced by the clustering-rethink
    increment 1 (the 2026-07-08 clustering-supercluster-rethink plan,
    private); flip to ``text-embedding-3-small`` after A/B validation via
    ``evaluation/clustering/cluster_eval.py``."""

    clustering_umap_dims: int = 0
    """Clustering-rethink increment 2 (finding F5), gated and default OFF.
    0 = no reduction: HDBSCAN runs on the precomputed cosine distance matrix
    of the full-dimensional embeddings (legacy behavior, byte-identical).
    >0 = UMAP-reduce embeddings to this many dims (cosine metric,
    random_state=42 for determinism) and run HDBSCAN on the reduced vectors
    with euclidean metric — the standard BERTopic-style pipeline; density
    estimation in ~10 dims is far better behaved than in 384/1536 dims.
    Typical useful range 5-15. Env var ``CLUSTERING_UMAP_DIMS``."""

    clustering_umap_n_neighbors: int = 15
    """UMAP locality knob; only read when ``clustering_umap_dims`` > 0.
    Smaller = more local structure (finer clusters), larger = more global.
    Env var ``CLUSTERING_UMAP_N_NEIGHBORS``."""

    clustering_text_contract: str = "ctv2"
    """Text recipe for the OpenAI clustering-embedding path (sc-followups
    2026-07-16). "ctv2" (default) = title + content_summary — which is the
    capture-time 300-char head sample, NOT an LLM summary; ~90% of
    clusterable pages sit at that cap. "ctv2b" (clustering-quality backlog,
    2026-08-14) = title + ~1200-char fetcher primary-text sample (no LLM
    call), falling back to ctv2's chain when primary text is unavailable.
    "ctv2s" = ctv2b plus conservative source-format-cue stripping (trailing
    title site-suffixes, bare domain-string tokens). "ctv3" = title +
    per-page LLM gist (gpt-4o-mini, 2-3 sentences, cached in
    embedding_gists; pages missing a gist fall back to title + primary text
    capped at 2000 words). The contract is baked into clustering_embeddings.model_key
    ("<model>@<contract>"), so both registers' embeddings coexist and
    switching is non-destructive. EVAL-GATED: stays ctv2 until the A/B
    verdict (evaluation/clustering/cluster_eval.py --text-contract) says
    otherwise — flipping re-partitions every leaf/group/SC assignment.
    Ignored by the legacy SBERT path. Env var CLUSTERING_TEXT_CONTRACT."""

    hdbscan_min_samples: int = 2
    """HDBSCAN ``min_samples`` — was hardcoded to 2 pre-increment-2 (finding
    F7); 2 is kept as the default for byte-identical behavior. Higher values
    make the density estimate more conservative, which suppresses the
    single-link-style chaining that merges unrelated topics through bridge
    pages. Env var ``HDBSCAN_MIN_SAMPLES``."""

    hdbscan_selection_method: str = "eom"
    """HDBSCAN ``cluster_selection_method`` — ``eom`` (legacy default) or
    ``leaf``. eom favors large stable clusters (can absorb subtopics); leaf
    picks the finest-grained leaves of the condensed tree (finding F8).
    Env var ``HDBSCAN_SELECTION_METHOD``."""

    hdbscan_selection_epsilon: float = 0.0
    """HDBSCAN ``cluster_selection_epsilon`` (finding F8). 0.0 = off (legacy).
    NOTE: the value's scale depends on the active metric branch — cosine
    distances (no UMAP) vs euclidean in UMAP space — so a tuned value does
    not transfer between ``clustering_umap_dims`` settings. Env var
    ``HDBSCAN_SELECTION_EPSILON``."""

    hdbscan_min_cluster_size: int = 2
    """Minimum HDBSCAN cluster size (floor; the runtime path scales this up
    with corpus volume via ``n_pages // 150``). Tunable via env var
    ``HDBSCAN_MIN_CLUSTER_SIZE``. Default 2 reads as: any 2+ pages with
    high enough density form a cluster.

    Tuning guidance: when the inclusion gate (skip_gate / retain-skipped-pages)
    is more permissive, more borderline pages enter the compendium, which
    produces more 2-page semantic-thin clusters. Bumping to 3 (or higher)
    pushes the borderline content into either larger semantic neighborhoods
    or into the featured-singletons starfield, which reads cleaner on the
    demo graph. See the 2026-04-26 retain-skipped-pages-audit-log plan
    (private), plan.md Finding 3, for the gate-permissiveness x
    cluster-size coupling rationale."""

    cluster_identity_enabled: bool = False
    """Batch B (4a): match each recluster run's clusters to the previous run
    by member page_content_id Jaccard, carry stable_id + name forward, and
    LLM-name only genuinely new clusters. Default off = legacy behavior
    (every run re-names everything). Env var ``CLUSTER_IDENTITY_ENABLED``."""

    agent_system_prompt_version: str = "v3"
    """Selects the registry entry ``agent_system_{version}`` in
    ``backend/prompts/templates.py`` for ``CompendiumAgent``'s system
    prompt. "v1" is the corpus-and-tools framing shipped through
    2026-08-24. "v2" (default since 2026-08-25) adds project
    self-awareness -- the agent knows it is embedded beneath the user's
    topic-constellation graph, so meta questions ("what am I looking at",
    "what does this graph show") resolve to that graph instead of falling
    through to generic-assistant answers -- plus an in-character
    out-of-scope response for unrelated queries. Same tool/marker/citation
    discipline in both. "v3" (default since 2026-09-28) forbids narrating
    a search instead of calling the tool and tightens the answer style;
    "v4" is an opt-in variant with stricter inline-citation rules that
    measured only marginally better at higher tool-call cost. Env var
    ``AGENT_SYSTEM_PROMPT_VERSION`` -- flipping to "v2" is the no-deploy
    rollback."""

    cluster_naming_prompt_version: str = "v1a"
    """Selects the registry entry ``cluster_naming_{version}`` in
    ``backend/prompts/templates.py`` for
    ``ClusteringService._build_naming_prompt`` (clustering-quality backlog,
    2026-08-14 -- registry migration of the prompt that was previously an
    inline f-string). "v1a" is byte-identical to the pre-migration prompt
    (DOMINANT-topic framing). "v1b" adds breadth guidance against naming
    only the most salient subset of a mixed cluster (e.g. 'Largest Fish
    Species' on a cluster that also covers fish anatomy/taxonomy/
    extinction). Stays v1a until evidence from
    ``evaluation/fixtures/cluster_naming/`` supports a flip --
    ``CLUSTER_IDENTITY_ENABLED`` means a version change only affects
    genuinely new clusters on future reclusters, not existing carried-
    forward names. Env var ``CLUSTER_NAMING_PROMPT_VERSION``."""

    cluster_identity_jaccard: float = 0.5
    """Minimum member-set Jaccard for a cross-run cluster match (greedy,
    highest-overlap-first). Env var ``CLUSTER_IDENTITY_JACCARD``."""

    supercluster_mode: str = "keywords"
    """'keywords' (legacy): LLM classifies clusters into typed topic_interests.
    'hybrid' (batch B 4b): groups discovered from cluster-centroid geometry
    via ``supercluster_discovery``; keywords are embedding-mapped ONTO groups;
    unmatched groups become suggested topics with interest tiers. Both modes
    write the display label to ``clusters.super_cluster``. Env var
    ``SUPERCLUSTER_MODE``."""

    supercluster_group_threshold: float = 0.65
    """Agglomerative cosine-distance cut for hybrid group discovery.
    0.65 = territory-sized groups (user-confirmed 2026-07-10; splits arrive
    via the batch-C suggestion flow). Env var ``SUPERCLUSTER_GROUP_THRESHOLD``."""

    supercluster_split_threshold: float = 0.55
    """Finer agglomerative cut used ONLY to derive split proposals for
    declared groups (batch C C2). Same linkage tree as
    ``supercluster_group_threshold``, lower cut height → strict nesting; a
    keyword group spanning >=2 subgroups at this cut gets a split proposal.
    Env var ``SUPERCLUSTER_SPLIT_THRESHOLD``."""

    supercluster_topic_match_threshold: float = 0.30
    """Minimum keyword-to-group-centroid cosine similarity for a topic label.
    Observed separation on user 152: real matches 0.30-0.55, non-matches
    0.14-0.26. Env var ``SUPERCLUSTER_TOPIC_MATCH_THRESHOLD``."""

    supercluster_carve_margin: float = 0.05
    """Cluster-level carve-out margin (fix B+C, 2026-07-14). A cluster inside
    a keyword-owned group is carved to a different keyword only when its
    individual sim beats its sim to the owning keyword by this much. Prod
    reference points: the real carves won by 0.13-0.20; no observed case sat
    near 0.05. Cluster-level claims reuse
    ``supercluster_topic_match_threshold`` as the entry bar. Env var
    ``SUPERCLUSTER_CARVE_MARGIN``."""

    supercluster_keyword_expansion: bool = True
    """Depth-1 umbrella expansion (2026-07-14): declared keywords lazily gain
    4-8 LLM-generated narrower sub-terms (stored as ``expansion_terms`` in
    their ``topic_interests`` entries); keyword similarity becomes the MAX
    over {keyword + terms}. Rationale: embedding space punishes generality —
    "science" peaked at 0.29 against clusters its facets describe at 0.4+.
    Kill switch for A/B or rollback. Env var
    ``SUPERCLUSTER_KEYWORD_EXPANSION``."""

    supercluster_group_support_min: float = 0.75
    """Support-fraction gate for keyword-group membership (fix-design
    2026-07-16). After group-level verification, a keyword-labeled group
    where fewer than this fraction of member clusters INDIVIDUALLY clear
    ``supercluster_topic_match_threshold`` (max-over-terms, the same sims
    the carve pass uses) is decomposed: passing members keep the keyword
    group, failing members move to a residual suggested group. Run-142
    evidence: support fractions 0.25 (volcano grab-bag, 8 passengers) and
    0.57 (mixed 3d-printing group, 3 passengers) vs 1.00 for the healthy
    zoology group; dispersion metrics do NOT separate (the all-misfire
    graphic-design pair was the most cohesive group in the run). 0.75 sits
    between the observed bands with margin. Cohesive groups are never
    touched — group averaging stays the recall mechanism. 0.0 disables.
    Env var ``SUPERCLUSTER_GROUP_SUPPORT_MIN``."""

    supercluster_singleton_merge_threshold: float = 0.57
    """Post-discovery singleton-collapse cosine-distance cut (clustering-
    quality backlog, item 3). Legally-single-member groups from
    ``supercluster_discovery.discover_groups`` (docstring: singleton groups
    are legal) are folded into their nearest multi-member group when the
    group-centroid cosine distance is <= this value; unmatched singletons
    stay singletons. Empirically set from run 171 (user 152, 8 singleton
    groups out of 22): measured nearest-multi-member distances were
    0.4717/0.4945/0.5265/0.5407/0.5488/0.5864/0.6364/0.6868, with the
    biggest gaps in the middle of the range (~0.55->0.59 and ~0.59->0.64,
    each ~0.05 wide) rather than one dominant cut point. 0.57 sits in the
    first of those gaps and matches the qualitative read of run 171's
    labels: it merges a same-label carve fragment ('Productivity Tools'
    into 'Productivity Tools'), while leaving Cricut Techniques / Samsung
    Galaxy Z Fold / Ethiopian Opals as singletons rather than folding them
    into an unrelated '3d printing' group. Review 2026-08-14 (fix 2) added
    a same-label guard alongside this threshold: a keyword-source singleton
    (a carve fragment or lone verified keyword match) may only merge into a
    target whose label matches its own — this DELIBERATELY blocks run 171's
    geometrically-eligible 'technology' -> 'Productivity Tools' merge
    (different labels), which the raw distance cut alone would have allowed
    but which would have silently undone the group's LLM-audited identity.
    Distinct from ``supercluster_group_threshold`` (0.65), not a relaxation
    of it: 0.65 is the bar for the ORIGINAL agglomerative discovery pass
    over all cluster centroids at once, while this cut applies POST-HOC to
    singletons that carve-outs and the support-gate residual mechanism
    create from members that were geometrically close to a real group all
    along (864/870 in run 171 both carved out of groups they sit under
    0.55 of) — so it is calibrated against that post-hoc singleton
    distance distribution, and numerically it happens to be stricter.
    0.0 disables the pass entirely (no merges). Env var
    ``SUPERCLUSTER_SINGLETON_MERGE_THRESHOLD``."""

    supercluster_label_prompt_version: str = "v1a"
    """Selects the registry entry ``supercluster_label_{version}`` in
    ``backend/prompts/templates.py`` for
    ``super_cluster_service._suggest_group_labels`` (clustering-quality
    backlog, 2026-08-14 -- registry migration of the prompt that was
    previously an inline string). "v1a" is byte-identical to the
    pre-migration prompt (2-4 word title-case label, no further
    constraints). "v1b" forbids bare one-word discipline labels ('Zoology',
    'Technology', 'Science') and brand-only labels, and requires
    distinctiveness against the run's other group labels. Stays v1a until
    evidence supports a flip -- no dedicated supercluster_label fixture set
    exists yet (only cluster_naming has one, under
    ``evaluation/fixtures/cluster_naming/``). Env var
    ``SUPERCLUSTER_LABEL_PROMPT_VERSION``."""

    featured_singletons_visible_pct: float = 0.40
    """Fraction of real cluster count to surface as LABELED featured singletons
    in the starfield. At 40% with N=29 real clusters, ~12 page-title-labeled
    starfield points. The remaining HDBSCAN-noise pages still render as faux
    1-page clusters scattered through the nebula (positioning + nebula glow)
    but without page-title labels -- they contribute to the visual density of
    the compendium graph without cluttering it with low-confidence labels.

    Selection algorithm: top-2K by HDBSCAN outlier_score, then greedy
    farthest-point sample K so the labeled points are spatially distributed
    in embedding space (avoids the middle-left clumping seen pre-2026-04-27).
    Tunable via env var ``FEATURED_SINGLETONS_VISIBLE_PCT``.

    History: started at 0.20 (6 visible) on 2026-04-27, bumped to 0.40
    (12 visible) after live testing showed the FE-side LOD fade now
    handles label density at zoom-out, so a higher default no longer
    risks clutter at fit-zoom -- the LOD will progressively hide weaker
    outliers as the user zooms out."""

    # ==========================================================================
    # Search Agent Configuration
    # ==========================================================================
    agent_relevance_threshold: float = 0.2
    """Minimum cross-encoder rerank score (sigmoid-mapped to [0,1]) for a
    search_compendium result to count as a confirmed match. Moved here from a
    module-local constant in ``agent.py`` (2026-07-16 astronomy-miss audit) so
    it's tunable without a code change, following the same pattern as
    ``supercluster_topic_match_threshold`` above. Below this, results fall
    through the search cascade (taxonomy match -> low-confidence fallback ->
    auto-widen -> structured absence) instead of being cited as answers.
    Verified 2026-04-29: a deliberately-weird query "trace test toroidal
    transformers" produced top-5 rerank scores [0.922, 0.784, 0.525, 0.096,
    0.000] -- 0.2 cleanly separates the real hits from the noise. Env var
    ``AGENT_RELEVANCE_THRESHOLD``."""

    agent_low_confidence_sim_floor: float = 0.40
    """Minimum bi-encoder cosine similarity (of the best of 25 pgvector
    candidates) for the search cascade's low-confidence fallback stage to
    fire. Catches hypernym/topic-label queries (e.g. "astronomy") where
    bi-encoder recall is healthy (cosine sims 0.45-0.51 in the audit that
    motivated this setting) but the cross-encoder reranker -- which rewards
    lexical/title overlap -- collapses every candidate below
    ``agent_relevance_threshold`` because no single page title contains the
    query term. Below this floor, the query is treated as genuinely absent
    rather than weakly matched. Env var ``AGENT_LOW_CONFIDENCE_SIM_FLOOR``."""

    # ==========================================================================
    # Computed Properties
    # ==========================================================================
    @model_validator(mode="after")
    def _check_production_secrets(self) -> "Settings":
        """Reject insecure defaults in production."""
        if self.environment != "development" and self.jwt_secret_key == "change-me-in-production":
            raise ValueError(
                "JWT_SECRET_KEY must be changed from the default in production. "
                "Set a strong random value in your .env file."
            )

        # CORS_ORIGINS=* is the dev-friendly default (.env.example ships it).
        # In production it'd let any website's JavaScript call our API while
        # piggybacking on a logged-in user's cookies/JWT. Hard-fail at startup
        # rather than the previous soft-warning + auto-restrict in main.py:
        # the warning was easy to miss in deploy logs and the auto-restrict
        # only worked because frontend_url was set; if it wasn't, '*' would
        # silently win. Opt-out via comma-separated explicit origin list.
        if self.environment != "development":
            origins = [o.strip() for o in self.cors_origins.split(",") if o.strip()]
            if "*" in origins or self.cors_origins.strip() == "*":
                raise ValueError(
                    "CORS_ORIGINS must be a comma-separated list of explicit "
                    "origins in production (e.g. 'https://compendium.example.com'); "
                    "the dev wildcard '*' is rejected."
                )

        # SESSION_TRUST_MISSING_INGRESS=1 treats an absent ingress header as
        # tailnet-trusted -- fine for local dev (no Caddy in front), but
        # anywhere else (staging, production, or a misspelled/unset
        # ENVIRONMENT) it would let ANY public caller (the header is simply
        # never present outside our own Caddy config) obtain a remembered/
        # 90-day, no-idle-lapse session. Hard-fail at startup for any
        # non-development environment, same pattern as the JWT secret / CORS
        # "*" checks above.
        if self.environment != "development" and self.session_trust_missing_ingress:
            raise ValueError(
                "SESSION_TRUST_MISSING_INGRESS is a dev-only knob; refused "
                "outside environment=development -- it would trust every "
                "public caller as tailnet-remembered."
            )

        # batch-06 (deploy-flip fix wave), final review: session_ingress_
        # trusted_value's shipped default is a known, non-secret string
        # documented in .env.example -- fine for local dev, but the review
        # found the client-supplied ingress header spoofable on public
        # paths (apps/web's Next auth routes used to relay it verbatim --
        # see apps/web/lib/ingress.ts's batch-06 fix -- and the tunnel path
        # reaches the API directly). If a production deploy still shipped
        # with the default active, any caller who could set the header
        # directly would obtain the remembered/90-day, no-idle-lapse
        # session. Hard-fail at startup outside development, same
        # allow-list pattern as the checks above; compare against the
        # field's own default rather than a hardcoded literal so this
        # validator (and its error message) never needs to spell out the
        # trusted value's string.
        if (
            self.environment != "development"
            and self.session_ingress_trusted_value
            == type(self).model_fields["session_ingress_trusted_value"].default
        ):
            raise ValueError(
                "SESSION_INGRESS_TRUSTED_VALUE must be changed from its default "
                "in production. Set a strong random value in your .env file."
            )

        return self

    @property
    def is_development(self) -> bool:
        """Check if running in development mode."""
        return self.environment == "development"

    @property
    def has_openai(self) -> bool:
        """Check if OpenAI API key is configured."""
        return bool(self.openai_api_key)

    @property
    def has_anthropic(self) -> bool:
        """Check if Anthropic API key is configured."""
        return bool(self.anthropic_api_key)

    @property
    def has_huggingface(self) -> bool:
        """Check if HuggingFace API key is configured."""
        return bool(self.hf_token)


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()


# Singleton instance
settings = get_settings()


# Sync LangSmith config into os.environ so the LangSmith SDK can find it.
# LangSmith reads os.environ directly, not pydantic-settings, so without this
# sync traces would be silently dropped even when keys are configured.
def _sync_langsmith_env() -> None:
    import os

    if settings.langchain_tracing_v2 and settings.langchain_api_key:
        # New-style LANGSMITH_* names (preferred by current SDK)
        os.environ["LANGSMITH_TRACING"] = "true"
        os.environ["LANGSMITH_API_KEY"] = settings.langchain_api_key
        os.environ["LANGSMITH_PROJECT"] = settings.langchain_project
        # Legacy LANGCHAIN_* names for older SDK versions
        os.environ["LANGCHAIN_TRACING_V2"] = "true"
        os.environ["LANGCHAIN_API_KEY"] = settings.langchain_api_key
        os.environ["LANGCHAIN_PROJECT"] = settings.langchain_project


_sync_langsmith_env()
