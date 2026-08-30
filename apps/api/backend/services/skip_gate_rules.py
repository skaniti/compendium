"""Deterministic pre-filter for the skip gate (Milestone 14, Phase 1 Step 5).

The skip gate in ``backend/api/main.py`` decides per page whether to include
it in the knowledge compendium. For most pages this is a gpt-4o-mini call
costing ~$0.00007 each. But on real usage data (see
``notebooks/14_01_scaling_and_cost.ipynb`` §2), **51.3% of decisions come
from domains with ≥95% one-sided outcome** — search engines, login walls,
banking portals, auth redirects. Those calls are deterministic waste.

This module is the FrugalGPT tier-0: a free rule-based layer in front of
the LLM. Pages whose hostname matches :data:`AUTO_SKIP_DOMAINS` get an
instant ``skipped`` decision; pages whose hostname matches
:data:`AUTO_PROCESS_DOMAINS` get an instant ``processed`` decision;
everything else falls through to the LLM (the existing skip-gate path).

Rule derivation
---------------
Each entry was derived from the live ``pages`` table (≥10 samples,
≥95% one-sided) on 2026-04-21. The expected error rate bound is 5%,
comparable to gpt-4o-mini's own measured error rate on Wikipedia
(3.8%, per M11). Every tier-0 decision emits a zero-cost
``cost_events`` row with ``event_type='skip_gate_deterministic'`` so
the cost-avoidance line is visible in the Trends dashboard.

Maintenance
-----------
The rule tables are static so they're auditable (no mystery "what
runs tier-0 today?"). Refresh cadence: roughly once per quarter, or
whenever the Trends dashboard shows a new domain exceeding ≥95%
one-sided at ≥10 samples. Add it to the list, commit, redeploy.
Removing an entry is safe — a wrongly-auto-decided domain falls back
to the LLM.
"""

from __future__ import annotations

from urllib.parse import urlparse

# ---------------------------------------------------------------------------
# Rule tables
# ---------------------------------------------------------------------------
#
# Domains with ≥95% skip rate on ≥10 samples as of 2026-04-21. Grouped by
# category so additions/removals stay reviewable; grouping has no runtime
# significance — all resolve to the same "skipped" decision.

AUTO_SKIP_DOMAINS: frozenset[str] = frozenset(
    {
        # Search engines (selected-result pages already have content; these
        # are the search-landing shells that don't).
        "www.google.com",
        "www.bing.com",
        "duckduckgo.com",
        # Mail / calendar / drive homepages (not individual email threads).
        "mail.google.com",
        "calendar.google.com",
        "drive.google.com",
        # Auth / SSO / login walls.
        "accounts.google.com",
        "login.microsoftonline.com",
        "login.live.com",
        # Workplace / LMS shells (content-free login/landing views; real
        # articles on the same domain would need a separate allowlist).
        "www.myworkday.com",
        # Dev local.
        "localhost",
        "127.0.0.1",
        # Status / social / screenshot tools (no lasting content).
        "status.claude.com",
        "code.claude.com",
        "www.instagram.com",
        "www.awesomescreenshot.com",
    }
)

# Domains with ≥95% process rate on ≥10 samples. Much rarer one-sidedness —
# most content domains are mixed because homepages coexist with articles.
# Ships empty: qualifying domains are corpus-specific (measured against one
# deployment's captures). Populate per deployment — e.g. a niche forum whose
# entire hostname is article-like content. Absent entries simply fall through
# to the LLM gate.
AUTO_PROCESS_DOMAINS: frozenset[str] = frozenset()

# en.wikipedia.org is already short-circuited earlier in the pipeline by
# ``LEARNING_GATE_DOMAINS`` for the *learning* gate. Not duplicated here.


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

DecisionT = tuple[str, str]
"""``(decision, reason)`` where ``decision`` is ``"skipped"`` or ``"processed"``."""


def check_domain_rule(url_or_hostname: str) -> DecisionT | None:
    """Return a deterministic decision for ``url_or_hostname``, or None to fall through.

    Accepts either a full URL (``https://www.google.com/search?q=...``) or a
    bare hostname (``www.google.com``). Case-insensitive.
    """
    if not url_or_hostname:
        return None

    host = url_or_hostname.strip().lower()
    if "://" in host:
        host = (urlparse(host).hostname or "").lower()
    if not host:
        return None

    if host in AUTO_SKIP_DOMAINS:
        return ("skipped", f"deterministic rule: {host} ≥95% skipped historically")
    if host in AUTO_PROCESS_DOMAINS:
        return ("processed", f"deterministic rule: {host} ≥95% processed historically")
    return None


def rule_counts() -> dict[str, int]:
    """Return a small snapshot useful for logging / dashboards."""
    return {
        "auto_skip_domains": len(AUTO_SKIP_DOMAINS),
        "auto_process_domains": len(AUTO_PROCESS_DOMAINS),
    }
