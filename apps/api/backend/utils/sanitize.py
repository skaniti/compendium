"""Input sanitization for LLM prompt safety.

Defends against two attack layers:
1. Python .format() injection — braces in user text could cause KeyError
   or attribute access (e.g., {0.__class__}).
2. LLM prompt injection — user-supplied content that attempts to override
   system instructions when interpolated into prompts.

The approach is defense-in-depth: escape format-string metacharacters,
strip control characters, and wrap in content delimiters so
the LLM treats user text as data rather than instructions.
"""

import re
import unicodedata


# Control characters (C0/C1) except common whitespace (\n, \r, \t)
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")


def sanitize_prompt_input(
    text: str,
    *,
    max_length: int | None = None,
    wrap_delimiters: bool = True,
) -> str:
    """Sanitize user-supplied text before interpolation into LLM prompts.

    Args:
        text: Raw user-supplied string (page title, content snippet, etc.)
        max_length: Optional truncation limit. None means no truncation
            (length enforcement belongs at the input validation layer).
        wrap_delimiters: If True, wrap result in <user_content> tags so the
            LLM treats the block as data rather than instructions.

    Returns:
        Sanitized string safe for use in ``template.format(**kwargs)``.
    """
    if not text:
        return text

    # 1. Truncate to max length (if specified)
    if max_length is not None:
        text = text[:max_length]

    # 2. Escape Python format-string braces: { → {{ , } → }}
    #    This prevents .format() from interpreting user text as placeholders.
    text = text.replace("{", "{{").replace("}", "}}")

    # 3. Strip control characters (keep newlines, tabs, carriage returns)
    text = _CONTROL_CHAR_RE.sub("", text)

    # 4. Normalize unicode to NFC (prevents homoglyph trickery)
    text = unicodedata.normalize("NFC", text)

    # 5. Wrap in content delimiters for LLM-level defense
    if wrap_delimiters and len(text) > 50:
        text = f"<user_content>\n{text}\n</user_content>"

    return text


# ---------------------------------------------------------------------------
# Agent query injection blocklist
#
# These phrases have zero legitimate use in a single-turn knowledge-retrieval
# query. In a single-turn call, "previous instructions" can ONLY mean the
# system prompt — the user has no prior instructions to override.
#
# See docs/project-plans/2026-04-06-security-reference.md for full rationale.
# ---------------------------------------------------------------------------
_AGENT_INJECTION_PATTERNS = [
    r"ignore\s+(all\s+)?previous\s+instructions",
    r"ignore\s+(all\s+)?prior\s+(instructions|directions)",
    r"disregard\s+(your|all|the)\s+(instructions|rules|prompt)",
    r"forget\s+(your|all)\s+instructions",
    r"you\s+are\s+now\s+",
    r"^SYSTEM\s*:",
    r"new\s+instructions?\s*:",
]
_AGENT_INJECTION_RE = re.compile(
    "|".join(f"(?:{p})" for p in _AGENT_INJECTION_PATTERNS),
    re.IGNORECASE,
)


class PromptInjectionError(ValueError):
    """Raised when an agent query matches a known injection pattern."""


def sanitize_agent_query(query: str, *, max_length: int = 2000) -> str:
    """Sanitize a user's agent/RAG query before sending to the LLM.

    Lighter-touch than prompt input sanitization: the user query IS the
    user's intent, so we don't escape braces or wrap in delimiters.
    We strip control characters, enforce length, and hard-block phrases
    that have no legitimate use in single-turn compendium queries.

    Raises:
        PromptInjectionError: If the query matches a known injection pattern.
    """
    if not query:
        return query

    query = query[:max_length]
    query = _CONTROL_CHAR_RE.sub("", query)

    # Normalize BEFORE pattern matching — closes homoglyph bypass
    query = unicodedata.normalize("NFC", query)

    match = _AGENT_INJECTION_RE.search(query)
    if match:
        raise PromptInjectionError(
            f"Query blocked: contains a phrase that targets system instructions "
            f"(matched: '{match.group()}'). Please rephrase your question."
        )

    return query.strip()
