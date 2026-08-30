"""Session title and mini-summary generation.

Shared function used by:
- Stage 4d (initial processing, clusters typically empty)
- _write_clusters_to_sessions() (after recluster, clusters populated)
"""

import re


# Suffixes commonly appended by sites — stripped for cleaner titles
_SITE_SUFFIXES = re.compile(
    r"\s*[-–—|]\s*("
    r"Wikipedia|YouTube|Reddit|Medium|Stack Overflow|GitHub"
    r"|Google Search|Amazon\.com|X \(formerly Twitter\)"
    r")$",
    re.IGNORECASE,
)


def _clean_page_title(title: str) -> str:
    """Strip common site-name suffixes from a page title."""
    return _SITE_SUFFIXES.sub("", title).strip()


def generate_session_title_and_summary(
    clusters: list[dict],
    page_titles: list[str],
    session_id: str,
    active_page_count: int | None = None,
) -> tuple[str, str]:
    """Derive a session title and mini-summary from clusters or page titles.

    Args:
        clusters: List of cluster dicts (each with a "name" key).
        page_titles: Titles of pages in the session.
        session_id: Fallback identifier if no titles are available.
        active_page_count: Number of pages that were actually processed
            (excluding skipped/catchall). Falls back to len(page_titles)
            when not provided.

    Returns:
        (session_title, mini_summary)
    """
    page_count = active_page_count if active_page_count is not None else len(page_titles)

    if clusters:
        names = [c["name"] if isinstance(c, dict) else c.name for c in clusters]
        if len(names) == 1:
            title = names[0]
        elif len(names) == 2:
            title = f"{names[0]} & {names[1]}"
        else:
            title = f"{names[0]}, {names[1]} & more"
        summary = f"Explored {', '.join(names)} across {page_count} pages"
        return title, summary

    # No clusters — build from page titles
    cleaned = []
    seen: set[str] = set()
    for raw in page_titles:
        if not raw:
            continue
        t = _clean_page_title(raw)
        if t and t.lower() not in seen:
            seen.add(t.lower())
            cleaned.append(t)
        if len(cleaned) == 3:
            break

    if cleaned:
        title = ", ".join(cleaned[:2])
        if len(cleaned) > 2:
            title += " & more"
    else:
        title = f"Session: {session_id}"

    summary = f"Browsed {page_count} pages"
    return title, summary
