"""Prompt templates for LLM interactions.

Milestone 4: Design and Test Core Prompts.

Template naming convention:
- {task}_{version} e.g., page_summary_v1

Each template includes:
- template: The prompt string with {placeholders}
- techniques: Prompting techniques used (instruction, few_shot, chain_of_thought)
- description: What this prompt does

Versioning strategy:
- Major version = framing (v1 = original, v2 = compendium/knowledge-contribution)
- Letter suffix = technique variant (a = baseline, b = structured, c = few-shot, d = CoT)
- Summarization: v1/v2/v3 (original M4 naming, unchanged)
- Journey narrative: v2a-d (compendium framing; v1 series removed — temporal framing)

Removed templates (temporal-model artifacts, no longer called):
- cluster_identification_v1/v2/v3 — replaced by HDBSCAN + SBERT clustering
- trigger_inference_v1a/v1b/v1c/v2a — trigger inference removed from pipeline
- journey_narrative_v1a/v1b/v1c — temporal "journey" framing
- analysis_planner_v1 — unimplemented M10 agent prompt

Hot-reloadable overrides:
    ``get_prompt()`` re-reads the override file on every call. Keys present
    there take precedence over the ``PROMPTS`` dict, so the Prompts dev view
    can edit templates without a restart. The file is
    ``settings.prompt_overrides_path`` (env ``PROMPT_OVERRIDES_PATH``), a
    deployment-local file outside the repo; when that is unset, the tracked
    ``overrides.json`` in this directory (kept ``{}``) is read instead, and
    nothing writes to it. Read cost is negligible for a solo dev tool --
    simplicity over speed.
"""

from datetime import date

# Date the production skip-gate prompt stabilized at its current version.
# Used by the Evidence dashboard L4 card: the sparkline renders a vertical
# marker at this x-position so the viewer can see whether skip-rate flattened
# after the prompt cutover.
#
# Source: derived from git log of this file.
# skip_gate_v2_3 promoted to production 2026-05-08 -- structural fix over
# v2.2 (URL-prior override moved from trailing advisory to top-level INCLUDE
# rule, evaluated BEFORE SKIP rules). Same-day head-to-head: 0 regression
# on selection_v1.1 and stress_v1.0; +2/4 on the new category_prior_override
# fixture set that anchored the 2026-05-08 PWM-tutorial finding. Earlier
# milestones: skip_gate_v2_2 promoted 2026-04-26; this constant marks the
# latest v2 cutover.
SKIP_GATE_V2_RELEASE: date = date(2026, 5, 8)

# =============================================================================
# Prompt Templates
# =============================================================================

PROMPTS = {
    # =========================================================================
    # Page Summarization
    # =========================================================================
    "page_summary_v1": {
        "template": """Summarize this Wikipedia article in 2-3 sentences.
Focus on the most interesting or memorable facts that would help someone remember what this page was about.
Do not include generic introductory phrases like "This article discusses..."

Article title: {title}
Article content:
{content}

Summary:""",
        "techniques": ["instruction"],
        "description": "Basic instruction-based page summarization",
    },
    "page_summary_v2": {
        "template": """Summarize this Wikipedia article in 2-3 sentences.
Focus on the most interesting or memorable facts that would help someone remember what this page was about.
Do not include generic introductory phrases like "This article discusses..."

Here are two examples of good summaries:

Example 1:
Article title: Tardigrade
Summary: Tardigrades are microscopic animals that can survive extreme conditions including the vacuum of space, temperatures from near absolute zero to 150°C, and pressures six times greater than the deepest ocean. They achieve this through cryptobiosis, a state where they lose almost all water content and essentially shut down their metabolism. First described in 1773, over 1,300 species have been identified across environments from deep sea trenches to Antarctic ice.

Example 2:
Article title: Voyager 1
Summary: Voyager 1, launched in 1977, is the most distant human-made object from Earth at over 15 billion miles away, and still sends data back despite its 1970s-era technology. It carries a Golden Record containing sounds and images of Earth intended for any extraterrestrial civilization that might find it. In 2012, it became the first spacecraft to enter interstellar space, crossing the heliopause boundary where the Sun's influence ends.

Now summarize the following article:

Article title: {title}
Article content:
{content}

Summary:""",
        "techniques": ["few_shot", "instruction"],
        "description": "Few-shot page summarization with example demonstrations",
    },
    "page_summary_v3": {
        "template": """Summarize this Wikipedia article. Follow these steps:

Step 1: Identify the 3-4 most important or surprising facts from the article.
Step 2: Determine what makes this topic distinctive or memorable.
Step 3: Synthesize into a 2-3 sentence summary that captures the essence.

Do not include generic introductory phrases like "This article discusses..."

Article title: {title}
Article content:
{content}

Step 1 - Key facts:
[List 3-4 key facts]

Step 2 - What's distinctive:
[What makes this notable]

Step 3 - Final summary:
[2-3 sentence summary]""",
        "techniques": ["chain_of_thought", "instruction"],
        "description": "Chain-of-thought summarization: identify facts, then synthesize",
    },
    # =========================================================================
    # Journey Narrative — v2 (compendium / knowledge-contribution framing)
    # =========================================================================
    "journey_narrative_v2a": {
        "template": """You are creating a compendium entry — a knowledge contribution report from a browsing session. This entry will be added to the reader's personal knowledge collection, organized by domain rather than browsing order.

Session data:
- Pages visited: {page_count} pages over {duration} minutes
- Knowledge domains identified: {clusters}
- Conceptual bridges between topics: {triggers}
- Content from each page: {summaries}

For each knowledge domain touched in this session, describe what was learned — the key facts, principles, or relationships the pages reveal. After covering individual domains, identify any cross-domain connections: shared principles, causal relationships, or thematic threads that link different areas of knowledge.

Write as a subject-matter expert documenting knowledge, not as a chatbot recapping browsing activity. Every sentence should convey substantive content. Do not reference the user, their browsing, or their clicks — write as if composing an encyclopedia entry that happens to cover these connected topics.

Aim for 150-300 words depending on session complexity.

Compendium Entry:""",
        "techniques": ["instruction"],
        "description": "Compendium-framed narrative — instruction only (baseline for v2 series)",
    },
    "journey_narrative_v2b": {
        "template": """You are creating a compendium entry — a knowledge contribution report from a browsing session. This entry will be added to the reader's personal knowledge collection, organized by domain rather than browsing order.

Session data:
- Pages visited: {page_count} pages over {duration} minutes
- Knowledge domains identified: {clusters}
- Conceptual bridges between topics: {triggers}
- Content from each page: {summaries}

Structure your entry as follows:
- **Knowledge Domains Touched**: For each cluster, a paragraph describing the key knowledge contributed — the facts, principles, or relationships the pages reveal.
- **Cross-Domain Connections**: How ideas from different domains relate — shared principles, causal links, or conceptual bridges.

Write as a subject-matter expert documenting knowledge, not as a chatbot recapping browsing activity. Every sentence should convey substantive content. Do not reference the user, their browsing, or their clicks — write as if composing an encyclopedia entry that happens to cover these connected topics.

Aim for 150-300 words depending on session complexity.

Compendium Entry:""",
        "techniques": ["instruction"],
        "description": "Compendium-framed narrative — instruction + light output schema",
    },
    "journey_narrative_v2c": {
        "template": """You are creating a compendium entry — a knowledge contribution report from a browsing session. This entry will be added to the reader's personal knowledge collection, organized by domain rather than browsing order.

Here is an example of a complete input and the desired compendium output:

Example session data:
- Pages visited: 5 pages over 2 minutes
- Knowledge domains identified: Hominid Taxonomy (3 pages: classification from great apes to australopithecines); Paleontology & Fossil Evidence (1 page: key hominin specimens); Geological Time (1 page: Miocene epoch and climate context)
- Conceptual bridges between topics: Hominidae -> Hominini: narrowing taxonomic focus from great ape family to human-lineage tribe; Hominini -> Australopithecine: exploring the key intermediate genus within the hominin tribe; Australopithecine -> Lucy (hominid): searching for the most famous specimen of the group just read about; Lucy (hominid) -> Miocene: tracing the geological epoch when great apes first diversified
- Content from each page: Hominidae: The family Hominidae comprises the great apes — four genera including Homo, Pan, Gorilla, and Pongo, sharing a common ancestor roughly 14 million years ago; Hominini: The tribe Hominini includes humans and their closest extinct relatives after divergence from chimpanzees approximately 6-7 million years ago; Australopithecine: Bipedal primates with small brains (about 35% of modern human cranial capacity) who lived across eastern and southern Africa from 4.2 to 1.9 million years ago; Lucy (hominid): Australopithecus afarensis specimen AL 288-1 discovered in Ethiopia in 1974, 40%-complete skeleton dated to 3.2 million years ago, providing key evidence that bipedalism preceded brain enlargement; Miocene: Geological epoch spanning 23 to 5.3 million years ago, characterized by cooling climates and shrinking forests that drove primate diversification

Example compendium entry:

**Hominid Taxonomy & Classification**
The family Hominidae — the great apes — comprises four living genera: Homo (humans), Pan (chimpanzees and bonobos), Gorilla, and Pongo (orangutans). Within this family, the tribe Hominini narrows the focus to species on the human lineage after divergence from chimpanzees roughly 6-7 million years ago. The australopithecines represent a crucial intermediate group: bipedal primates with small brains (about 35% of modern human cranial capacity) who thrived across eastern and southern Africa from approximately 4.2 to 1.9 million years ago.

**Paleontological Evidence**
The most famous australopithecine specimen, "Lucy" (Australopithecus afarensis, AL 288-1), was discovered in Ethiopia's Afar Triangle in 1974. Her 40%-complete skeleton — extraordinary for a 3.2-million-year-old fossil — provided definitive evidence that bipedalism preceded brain enlargement in human evolution.

**Cross-Domain Connections**
The Miocene epoch (23-5.3 million years ago) provides the geological context for great ape diversification. Cooling climates and shrinking forests during the late Miocene created the selective pressures that favored the shift from arboreal to terrestrial locomotion — the environmental precondition for the bipedal australopithecines that would eventually give rise to Homo.

Now create a compendium entry for this session:

Session data:
- Pages visited: {page_count} pages over {duration} minutes
- Knowledge domains identified: {clusters}
- Conceptual bridges between topics: {triggers}
- Content from each page: {summaries}

Structure your entry as follows:
- **Knowledge Domains Touched**: For each cluster, a paragraph describing the key knowledge contributed.
- **Cross-Domain Connections**: How ideas from different domains relate — shared principles, causal links, or conceptual bridges.

Write as a subject-matter expert documenting knowledge. Every sentence should convey substantive content. Do not reference the user or their browsing.

Aim for 150-300 words depending on session complexity.

Compendium Entry:""",
        "techniques": ["one_shot", "instruction"],
        "description": "Compendium-framed narrative — one-shot with real hominid session example (full input→output) + schema",
    },
    "journey_narrative_v2d": {
        "template": """You are creating a compendium entry — a knowledge contribution report from a browsing session.

Session data:
- Pages visited: {page_count} pages over {duration} minutes
- Knowledge domains identified: {clusters}
- Conceptual bridges between topics: {triggers}
- Content from each page: {summaries}

Before writing the entry, reason through these steps:
1. What knowledge domains did this session touch? List them.
2. For each domain, what are the key facts or principles learned?
3. Are there cross-domain connections — shared principles, causal links, or surprising overlaps?
4. What is the most important thing someone would want to remember from this session?

Now, using your reasoning, write the compendium entry. Write as a subject-matter expert documenting knowledge. Every sentence should convey substantive content. Do not reference the user or their browsing.

Aim for 150-300 words.

Reasoning:
[Your analysis of the session's knowledge contributions]

Compendium Entry:
[Your final entry]""",
        "techniques": ["chain_of_thought", "instruction"],
        "description": "Compendium-framed narrative — chain-of-thought reasoning before writing",
    },
    # =========================================================================
    # Skip Gate (Stage 1 — live pipeline)
    # =========================================================================
    "skip_gate_v1": {
        "template": """Should this page be included in a knowledge compendium?

Title: {title}
URL: {url}
Domain: {domain}
Content preview ({snippet_len} chars): {snippet}

INCLUDE unless the page is clearly one of these:
- Homepage with no article content (e.g., 'Wikipedia, the free encyclopedia')
- Login wall, auth page, or sign-in redirect
- Pure search results with no selected result
- Error page or HTTP error

When in doubt, INCLUDE. Product pages, help docs, forum posts, marketplace listings, and profile pages all have real content. Judge ONLY on content, not on dwell time or user behavior.""",
        "techniques": ["instruction"],
        "description": "Binary skip gate — include or skip a page for the compendium",
    },
    "skip_gate_v2": {
        "template": """Should this page be included in a knowledge compendium?

Title: {title}
URL: {url}
Domain: {domain}
Content preview ({snippet_len} chars): {snippet}

The compendium captures pages the user actively learns from -- not a complete browse log. AI-chat conversations sit ABOVE this layer as a curatorial surface; pages a user only cared about because of a related chat (product picks, icon shortlists, font browsing) belong to the chat, not the destination page.

URL semantics are a strong fast-filter signal. Use them as a PRIOR, then confirm with title and snippet. The snippet can override the URL prior.

SKIP if any of:
- Homepage / index page with no article content (e.g., 'Wikipedia, the free encyclopedia')
- Login wall, auth page, sign-in redirect
- Search results page (no specific result selected)
- Error page or HTTP error
- Marketplace / product / store / listing / pricing page (intent is purchase or acquisition, not learning). URL clues: /products/, /shop/, /cart/, /listing/, /pricing/, /plans/, /checkout/.
- User-specific page (profile, account, dashboard, settings, inbox). URL clues: /profile/, /account/, /@username, /settings/, /dashboard/.
- Asset library browse or category page -- flat list/grid of items (icons, fonts, vectors, 3D models, templates) with no narrative flow. A page that walks through HOW to USE such a library (sequential instruction or examples) is a tutorial -- INCLUDE.
- Entertainment video (music videos, shorts, vlogs without educational narration). URL clues: youtube.com/shorts/, tiktok.com. Snippet clues: artist name, "Official Video", "Official MV", reaction content. Also: if a YouTube /watch/ video's snippet contains no narrative or instructional content (just descriptions, fan comments, artist names), default skip.
- Local file URL (file:// scheme) -- not a captured web page.

INCLUDE if the page has substantive content the user could learn from: encyclopedic articles, blog posts, technical Q&A, tutorial content, in-depth reviews, research papers, news with analysis, documentation.

When the URL pattern strongly suggests skip but the title or snippet clearly indicates substantive content (e.g., a /pricing/ page that is actually an analytical breakdown, or a long-form video documentary), INCLUDE. The URL signal is a prior, not a verdict.

Judge ONLY on content + URL semantics, not on dwell time or user behavior. When in doubt about whether the page contains real learnable material, INCLUDE.""",
        "techniques": ["instruction", "url_semantics", "curatorial_layer"],
        "description": "v2: drops product-page carve-out, adds URL semantics + curatorial-layer principle + asset-library narrative-flow distinction; eval-only until validated against selection_v1.0",
    },
    "skip_gate_v2_2": {
        "template": """Should this page be included in a knowledge compendium?

Title: {title}
URL: {url}
Domain: {domain}
Content preview ({snippet_len} chars): {snippet}

The compendium captures pages the user actively learns from -- not a complete browse log. AI-chat conversations sit ABOVE this layer as a curatorial surface; pages a user only cared about because of a related chat (product picks, icon shortlists, font browsing) belong to the chat, not the destination page.

URL semantics are a strong fast-filter signal. Use them as a PRIOR, then confirm with title and snippet. The snippet can override the URL prior.

EVALUATE INCLUDE RULES FIRST. Only fall through to SKIP rules if no INCLUDE rule matches.

INCLUDE if any of:
- Substantive content the user could learn from: encyclopedic articles, blog posts, technical Q&A, tutorial content, in-depth reviews, research papers, news with analysis, documentation.
- Individual ITEM pages (one specific model, font, icon, game, document, tool, library, etc.) with their own description, instructions, or content -- EVEN IF hosted on a marketplace, asset-library, or transactional platform. URL clue: a path with a specific item id-and-slug (e.g., /model/123-widget-stand-modular/, /boardgame/4567/star-freighter/, /filepage/8901/star-freighter-quick-reference). Confirm via snippet: substantive description of WHAT it is, HOW it works, materials, mechanics, build instructions, contents, or features.

SKIP only if no INCLUDE rule matched, AND the page is one of:
- Homepage / index page with no article content (e.g., 'Wikipedia, the free encyclopedia')
- Login wall, auth page, sign-in redirect
- Search results page (no specific result selected)
- Error page or HTTP error
- Marketplace / product / store / listing / pricing page -- the page's PRIMARY purpose is to facilitate a purchase or acquisition. URL clues: /products/, /shop/, /cart/, /listing/, /pricing/, /plans/, /checkout/. SKIP signal in snippet: emphasis on price, ratings, "buy now", shipping, stock, store policies, "Add to cart".
- User-specific page (profile, account, dashboard, settings, inbox). URL clues: /profile/, /account/, /@username, /settings/, /dashboard/.
- Asset library browse / category / index page -- a flat list or grid of MULTIPLE items (icons, fonts, vectors, 3D models, templates) with no narrative description of any specific item.
- Entertainment video (music videos, shorts, vlogs without educational narration). URL clues: youtube.com/shorts/, tiktok.com. Snippet clues: artist name, "Official Video", "Official MV", reaction content. Also: if a YouTube /watch/ video's snippet contains no narrative or instructional content (just descriptions, fan comments, artist names), default skip.
- Local file URL (file:// scheme) -- not a captured web page.

When the URL pattern strongly suggests skip but the title or snippet clearly indicates substantive content, INCLUDE. The URL signal is a prior, not a verdict.

Judge ONLY on content + URL semantics, not on dwell time or user behavior. When in doubt about whether the page contains real learnable material, INCLUDE.""",
        "techniques": ["instruction", "url_semantics", "curatorial_layer", "item_page_distinction", "include_first_ordering"],
        "description": "v2.2: structural fix over v2.1 -- promotes item-page rule to a top-level INCLUDE category, evaluated BEFORE SKIP rules. Targets v2.1's failure mode where marketplace SKIP fired before LLM reached the item-page exception. Single-rule restructuring; no other rule changes vs v2.1.",
    },
    "skip_gate_v2_3": {
        "template": """Should this page be included in a knowledge compendium?

Title: {title}
URL: {url}
Domain: {domain}
Content preview ({snippet_len} chars): {snippet}

The compendium captures pages the user actively learns from -- not a complete browse log. AI-chat conversations sit ABOVE this layer as a curatorial surface; pages a user only cared about because of a related chat (product picks, icon shortlists, font browsing) belong to the chat, not the destination page.

URL semantics are a strong fast-filter signal. Use them as a PRIOR, then confirm with title and snippet. The snippet can override the URL prior.

EVALUATE INCLUDE RULES FIRST. Only fall through to SKIP rules if no INCLUDE rule matches.

INCLUDE if any of:
- Substantive content the user could learn from: encyclopedic articles, blog posts, technical Q&A, tutorial content, in-depth reviews, research papers, news with analysis, documentation.
- Individual ITEM pages (one specific model, font, icon, game, document, tool, library, etc.) with their own description, instructions, or content -- EVEN IF hosted on a marketplace, asset-library, or transactional platform. URL clue: a path with a specific item id-and-slug (e.g., /model/123-widget-stand-modular/, /boardgame/4567/star-freighter/, /filepage/8901/star-freighter-quick-reference). Confirm via snippet: substantive description of WHAT it is, HOW it works, materials, mechanics, build instructions, contents, or features.
- URL-prior override: when the URL alone would match a SKIP rule below (youtube.com/watch/, youtube.com/shorts/, /products/, /pricing/, /shop/, /listing/, /@username, /profile/, /dashboard/, etc.) BUT the title or snippet clearly carries substantive learnable content -- a transcript narrating instruction, an analytical breakdown, an in-depth review or essay, a documentary explainer, a long-form analysis -- INCLUDE. The URL is a prior, not a verdict; concrete educational or analytical content in the snippet wins.

SKIP only if no INCLUDE rule matched, AND the page is one of:
- Homepage / index page with no article content (e.g., 'Wikipedia, the free encyclopedia')
- Login wall, auth page, sign-in redirect
- Search results page (no specific result selected)
- Error page or HTTP error
- Marketplace / product / store / listing / pricing page -- the page's PRIMARY purpose is to facilitate a purchase or acquisition. URL clues: /products/, /shop/, /cart/, /listing/, /pricing/, /plans/, /checkout/. SKIP signal in snippet: emphasis on price, ratings, "buy now", shipping, stock, store policies, "Add to cart".
- User-specific page (profile, account, dashboard, settings, inbox). URL clues: /profile/, /account/, /@username, /settings/, /dashboard/.
- Asset library browse / category / index page -- a flat list or grid of MULTIPLE items (icons, fonts, vectors, 3D models, templates) with no narrative description of any specific item.
- Entertainment video (music videos, shorts, vlogs without educational narration). URL clues: youtube.com/shorts/, tiktok.com. Snippet clues: artist name, "Official Video", "Official MV", reaction content. Also: if a YouTube /watch/ video's snippet contains no narrative or instructional content (just descriptions, fan comments, artist names), default skip.
- Local file URL (file:// scheme) -- not a captured web page.

Judge ONLY on content + URL semantics, not on dwell time or user behavior. When in doubt about whether the page contains real learnable material, INCLUDE.""",
        "techniques": ["instruction", "url_semantics", "curatorial_layer", "item_page_distinction", "include_first_ordering", "url_prior_override"],
        "description": "v2.3: structural fix over v2.2 -- promotes the URL-prior override clause from a trailing advisory line to a top-level INCLUDE rule, evaluated BEFORE SKIP rules. Targets v2.2's failure mode where the YouTube /watch/ category prior overrode snippet evidence on educational tutorials (PWM tutorial, 2026-05-08 demo dry-run).",
    },
    "skip_gate_v2_1": {
        "template": """Should this page be included in a knowledge compendium?

Title: {title}
URL: {url}
Domain: {domain}
Content preview ({snippet_len} chars): {snippet}

The compendium captures pages the user actively learns from -- not a complete browse log. AI-chat conversations sit ABOVE this layer as a curatorial surface; pages a user only cared about because of a related chat (product picks, icon shortlists, font browsing) belong to the chat, not the destination page.

URL semantics are a strong fast-filter signal. Use them as a PRIOR, then confirm with title and snippet. The snippet can override the URL prior.

SKIP if any of:
- Homepage / index page with no article content (e.g., 'Wikipedia, the free encyclopedia')
- Login wall, auth page, sign-in redirect
- Search results page (no specific result selected)
- Error page or HTTP error
- Marketplace / product / store / listing / pricing page -- the page's PRIMARY purpose is to facilitate a purchase or acquisition, not to describe an artifact for understanding. URL clues: /products/, /shop/, /cart/, /listing/, /pricing/, /plans/, /checkout/. SKIP signal in snippet: emphasis on price, ratings, "buy now", shipping, stock, store policies, "Add to cart". INCLUDE signal in snippet: substantive description of HOW something works, what it does, mechanics, materials, build instructions -- even if the artifact is also sold somewhere. The test is "does this page exist mainly to sell, or mainly to share/document?"
- User-specific page (profile, account, dashboard, settings, inbox). URL clues: /profile/, /account/, /@username, /settings/, /dashboard/.
- Asset library browse / category / index page -- a flat list or grid of MULTIPLE items (icons, fonts, vectors, 3D models, templates) with no narrative description of any specific item. EXCLUDED from this category: individual ITEM pages (one specific model, one specific font, one specific icon, one specific game, one specific reference document) with their own description, instructions, or content -- those are INCLUDE. Item pages describe ONE thing in depth; browse pages list many things shallowly. URL clue: a path with a specific item's id-and-slug (e.g., /model/123-widget-stand-modular/, /boardgame/4567/star-freighter/, /filepage/8901/star-freighter-quick-reference) typically signals an item page; a path like /models/, /icons/categories/, or /@username typically signals a browse page. A page that walks through HOW to USE a library (sequential instruction or examples) is a tutorial -- INCLUDE.
- Entertainment video (music videos, shorts, vlogs without educational narration). URL clues: youtube.com/shorts/, tiktok.com. Snippet clues: artist name, "Official Video", "Official MV", reaction content. Also: if a YouTube /watch/ video's snippet contains no narrative or instructional content (just descriptions, fan comments, artist names), default skip.
- Local file URL (file:// scheme) -- not a captured web page.

INCLUDE if the page has substantive content the user could learn from: encyclopedic articles, blog posts, technical Q&A, tutorial content, in-depth reviews, research papers, news with analysis, documentation.

When the URL pattern strongly suggests skip but the title or snippet clearly indicates substantive content (e.g., a /pricing/ page that is actually an analytical breakdown, or a long-form video documentary), INCLUDE. The URL signal is a prior, not a verdict.

Judge ONLY on content + URL semantics, not on dwell time or user behavior. When in doubt about whether the page contains real learnable material, INCLUDE.""",
        "techniques": ["instruction", "url_semantics", "curatorial_layer", "item_page_distinction"],
        "description": "v2.1: refines asset-library rule to distinguish individual item pages from browse pages (Printables /model/<id>/, BGG /boardgame/<id>/, etc.); clarifies marketplace rule with purchase-intent vs descriptive-intent signals; targets 5 of 9 v2-vs-v1.1 wrongs",
    },
    # =========================================================================
    # Learning Gate (pre-clustering classification)
    # =========================================================================
    "learning_gate_v1": {
        "template": """You are classifying a web page for a personal knowledge compendium.
The question is: "Was the user actively learning or researching something?"

Page:
- Title: {title}
- Domain: {domain}
- Content preview: {snippet}

LEARNING examples: Wikipedia articles, tutorial pages, documentation,
forum discussions about how things work, academic papers, AI chat sessions
in which a topic is explored in depth, product research (comparing
features, reading reviews), recipe pages, how-to guides, news articles
with substantive content.

NOT LEARNING examples: login/auth pages, shopping cart or order pages,
search result listings (without a selected result), AI chat sessions
with no specific topic, app homepages, social media feeds,
account settings, file manager pages.

BORDERLINE guidance: When in doubt, classify as LEARNING. A product
page where someone is researching options IS learning. A forum post
where someone asks a question IS learning. Err toward inclusion.

Respond with exactly one word: LEARNING or SKIP""",
        "techniques": ["instruction"],
        "description": "Binary learning gate — classify whether a page represents active learning/research",
    },
    # =========================================================================
    # Search Agent (CompendiumAgent ReAct system prompt)
    # =========================================================================
    "agent_system_v1": {
        "template": """You are a personal research librarian for the user's browsing compendium: a collection of web pages captured across many browsing sessions, organized into topic clusters (and topic-labeled superclusters) by an ML pipeline.

Prior conversation turns may be included before the current question -- use them to resolve follow-up references (e.g. "it", "that topic", "the second one") to what was already discussed.

Your tools:
- search_compendium: two-stage semantic search (bi-encoder recall + cross-encoder rerank) over the user's compendium. Pass include_archived=true to also search archived/excluded pages (business lookups, navigation/search pages, deduped or manually-removed pages); the default (false) searches only the curated, in-graph pages. Result lines carry a page id ([id=123]) when resolvable -- pass it to get_page_detail for the full page content.

  Read the result markers before answering:
  - No marker: a normal relevance-ranked hit. Cite it directly.
  - "[archived]": sourced from an archived/excluded page, not the active compendium -- say so explicitly if you use it.
  - "[low-confidence]": semantically related to the query but below the confidence threshold -- these are candidates, not confirmed answers. Only use them if genuinely relevant to the question, and flag the uncertainty.
  - "Taxonomy match: ...": the query matched a cluster or supercluster NAME, not page content -- it means the user's compendium HAS a topic area with this name, and lists its member pages. This is a structural fact, not a content-relevance ranking; describe what the topic area covers rather than claiming the listed pages individually rank as top search hits.
  - "No relevant matches: ... this topic appears absent ...": a diagnosed absence, not a generic failure. The numbers (candidates evaluated, best scores) tell you how close the nearest content came; use that to judge whether a rephrase is worth trying.
- list_clusters: overview of all topic clusters and superclusters, grouped by supercluster, with page counts. Use when the user asks about their compendium structure, or to name the nearest topic areas the user DOES have after a genuine absence.
- get_cluster_info: pages within a specific cluster or supercluster (matched by name, with typo tolerance). Use when search already surfaced relevant pages and you need broader context within the topic, or to explore further after a taxonomy match.
- get_page_detail: full content for a single page, by id (search results and cluster listings both carry ids). Use when a chunk preview is insufficient to answer.

Strategy (stop calling tools as soon as you can answer):
1. Call search_compendium ONCE with the user's query.
2. Read the result markers (above) and synthesize the answer. Do NOT call additional tools unless the question genuinely requires content from a page you do not yet have, or the result was a taxonomy match needing follow-up.
3. On a genuine absence (a diagnosed "No relevant matches" with no taxonomy or low-confidence hit): optionally call list_clusters ONCE to name the nearest topic areas the user's compendium DOES cover, optionally reformulate the query ONCE into a more specific multi-word phrasing and search again, and only then tell the user the compendium has nothing on the topic. You may then offer 1-2 authoritative external starting points (e.g. a Wikipedia URL), clearly labeled as external.
4. If the user explicitly asks to search everything or archived content, or says they know it is there, call search_compendium with include_archived=true.

When answering:
- Cite compendium sources as [Page Title](URL).
- Label [archived], [low-confidence], and taxonomy-match results clearly per the marker guidance above; never present them as ordinary top-relevance hits.
- Ground every compendium claim in content actually returned by tools. Do NOT fall back on training-data knowledge to fill gaps; if the compendium does not have it, say so.
- Be concise. Lead with the answer, then supporting detail.""",
        "techniques": ["instruction", "tool_use", "react"],
        "description": (
            "CompendiumAgent system prompt -- ReAct search agent over 4 tools "
            "(search_compendium/get_cluster_info/get_page_detail/list_clusters); "
            "documents the search cascade's result markers ([archived], "
            "[low-confidence], taxonomy match, diagnosed absence) and the "
            "reformulate-once-before-declaring-absence strategy. Replaces the "
            "hardcoded SYSTEM_PROMPT constant (2026-07-16 astronomy-miss fix: "
            "full_search merged into search_compendium's include_archived param, "
            "taxonomy-name matching added, threshold moved to settings)."
        ),
    },
    "agent_system_v2": {
        "template": """You are the compendium's built-in chat -- a personal research librarian for the user's browsing compendium: a collection of web pages captured across many browsing sessions, organized into topic clusters (and topic-labeled superclusters) by an ML pipeline.

Where you live: you are embedded in the Compendium app, directly beneath the user's topic constellation -- a force-directed star-map of their own browsing. Each dot is a page they captured; dots group into named topic clusters (the labeled, glowing regions); related clusters group into superclusters; and pages that fit no cluster appear as unclustered "noise" points the user can toggle on and off. The sources you cite render as clickable pills that light up the matching node on that graph. So "node" and "dot" mean a captured PAGE, while a cluster is the named grouping pages fall into -- when the user asks how many of something there are, be explicit about which you are counting.

So when the user says "this graph", "here", "what am I looking at", "these clusters", or "the map", they mean that constellation of their own browsing sitting directly above this chat. You know what it is -- never say you cannot see images, and never ask them to describe or clarify which graph they mean. Answer with your tools: call list_clusters and describe the actual topic areas and counts in front of them, not the interface in the abstract. Keep the orientation SHORT -- a sentence or two on what the constellation is and how many topic areas it holds, then the handful of largest or most distinctive ones by name. Never dump the full cluster listing; offer to go deeper instead. A direct counting question ("how many X are there") just gets the number and what it counts -- no topic list appended.

A bare greeting gets one in-character sentence about what you can do with their compendium -- no tool call, and never a generic "how can I assist you today?".

Prior conversation turns may be included before the current question -- use them to resolve follow-up references (e.g. "it", "that topic", "the second one") to what was already discussed.

Your tools:
- search_compendium: two-stage semantic search (bi-encoder recall + cross-encoder rerank) over the user's compendium. Pass include_archived=true to also search archived/excluded pages (business lookups, navigation/search pages, deduped or manually-removed pages); the default (false) searches only the curated, in-graph pages. Result lines carry a page id ([id=123]) when resolvable -- pass it to get_page_detail for the full page content.

  Read the result markers before answering:
  - No marker: a normal relevance-ranked hit. Cite it directly.
  - "[archived]": sourced from an archived/excluded page, not the active compendium -- say so explicitly if you use it.
  - "[low-confidence]": semantically related to the query but below the confidence threshold -- these are candidates, not confirmed answers. Only use them if genuinely relevant to the question, and flag the uncertainty.
  - "Taxonomy match: ...": the query matched a cluster or supercluster NAME, not page content -- it means the user's compendium HAS a topic area with this name, and lists its member pages. This is a structural fact, not a content-relevance ranking; describe what the topic area covers rather than claiming the listed pages individually rank as top search hits.
  - "No relevant matches: ... this topic appears absent ...": a diagnosed absence, not a generic failure. The numbers (candidates evaluated, best scores) tell you how close the nearest content came; use that to judge whether a rephrase is worth trying.
- list_clusters: overview of all topic clusters and superclusters, grouped by supercluster, with page counts. Use when the user asks about their compendium structure or about the graph itself, or to name the nearest topic areas the user DOES have after a genuine absence.
- get_cluster_info: pages within a specific cluster or supercluster (matched by name, with typo tolerance). Use when search already surfaced relevant pages and you need broader context within the topic, or to explore further after a taxonomy match.
- get_page_detail: full content for a single page, by id (search results and cluster listings both carry ids). Use when a chunk preview is insufficient to answer.

Strategy (stop calling tools as soon as you can answer):
1. Meta questions about the compendium or the graph ITSELF -- "what am I looking at", "what does this graph show", "what is in here", "what topics do I have", "how many clusters are there" -- are answered with list_clusters (ONCE), not search_compendium. Describe their actual topic areas and counts; do not search for the words of the question.
2. Otherwise, call search_compendium ONCE with the user's query.
3. Read the result markers (above) and synthesize the answer. Do NOT call additional tools unless the question genuinely requires content from a page you do not yet have, or the result was a taxonomy match needing follow-up.
4. On a genuine absence (a diagnosed "No relevant matches" with no taxonomy or low-confidence hit): optionally call list_clusters ONCE to name the nearest topic areas the user's compendium DOES cover, optionally reformulate the query ONCE into a more specific multi-word phrasing and search again, and only then tell the user the compendium has nothing on the topic. You may then offer 1-2 authoritative external starting points (e.g. a Wikipedia URL), clearly labeled as external.
5. If the user explicitly asks to search everything or archived content, or says they know it is there, call search_compendium with include_archived=true.

When answering:
- Cite compendium sources as [Page Title](URL).
- Label [archived], [low-confidence], and taxonomy-match results clearly per the marker guidance above; never present them as ordinary top-relevance hits.
- Ground every compendium claim in content actually returned by tools. Do NOT fall back on training-data knowledge to fill gaps; if the compendium does not have it, say so.
- Be concise. Lead with the answer, then supporting detail.

Out of scope: some questions are outside what you can do -- general knowledge, coding help, current events, math, anything unrelated to this person's captured browsing. Stay in character. Say plainly what you are -- a search agent over the pages THEY captured, with no web access and no tools beyond their compendium -- and offer the nearest thing you can do (search the compendium for that topic, or name the topic areas they do have). One or two sentences. No apology spiral, and never break frame into a general-purpose assistant.""",
        "techniques": ["instruction", "tool_use", "react", "self_awareness"],
        "description": (
            "Project-self-aware framing of agent_system_v1 (2026-08-25). v1 "
            "described the CORPUS and the four tools but never the PRODUCT "
            "the chat is embedded in, so meta questions had no referent and "
            "fell through to generic-assistant training: the 2026-08-24 "
            "prod-mode demo pass got \"provide more context\" for \"what am i "
            "looking at here?\" and \"I can't view images directly\" for \"what "
            "does this graph show?\", while tool-backed questions answered "
            "correctly. v2 adds (a) a 'Where you live' block grounding the "
            "agent in the topic-constellation graph it sits under (clusters, "
            "superclusters, toggleable noise, source pills that cite back "
            "onto the graph) plus an explicit deictic-resolution rule for "
            "\"this graph\"/\"here\"/\"what am I looking at\", (b) an "
            "out-of-scope block that answers unrelated queries in character "
            "instead of breaking frame, and a Strategy step 1 routing meta "
            "questions to list_clusters rather than search_compendium (the "
            "self-awareness blocks would otherwise fight v1's "
            "search-compendium-first rule), with an explicit "
            "no-full-listing brevity rule on that path (a first probe run "
            "answered \"what am i looking at here?\" with all 16 "
            "superclusters enumerated). Tool/marker/citation discipline "
            "is byte-identical to v1 apart from the list_clusters 'or about "
            "the graph itself' clause and the Strategy renumbering. NOTE: "
            "the agent receives no live view state -- /api/agent/query "
            "carries only query + history -- so this is static product "
            "self-description grounded through list_clusters, not awareness "
            "of the current selection or noise toggle."
        ),
    },
    "agent_system_v3": {
        "template": """You are the compendium's built-in chat -- a personal research librarian for the user's browsing compendium: a collection of web pages captured across many browsing sessions, organized into topic clusters (and topic-labeled superclusters) by an ML pipeline.

Where you live: you are embedded in the Compendium app, directly beneath the user's topic constellation -- a force-directed star-map of their own browsing. Each dot is a page they captured; dots group into named topic clusters (the labeled, glowing regions); related clusters group into superclusters; and pages that fit no cluster appear as unclustered "noise" points the user can toggle on and off. The sources you cite render as clickable pills that light up the matching node on that graph. So "node" and "dot" mean a captured PAGE, while a cluster is the named grouping pages fall into -- when the user asks how many of something there are, be explicit about which you are counting.

So when the user says "this graph", "here", "what am I looking at", "these clusters", or "the map", they mean that constellation of their own browsing sitting directly above this chat. You know what it is -- never say you cannot see images, and never ask them to describe or clarify which graph they mean. Answer with your tools: call list_clusters and describe the actual topic areas and counts in front of them, not the interface in the abstract. Keep the orientation SHORT -- a sentence or two on what the constellation is and how many topic areas it holds, then the handful of largest or most distinctive ones by name. Never dump the full cluster listing; offer to go deeper instead. A direct counting question ("how many X are there") just gets the number and what it counts -- no topic list appended.

A bare greeting gets one in-character sentence about what you can do with their compendium -- no tool call, and never a generic "how can I assist you today?".

Prior conversation turns may be included before the current question -- use them to resolve follow-up references (e.g. "it", "that topic", "the second one") to what was already discussed.

Your tools:
- search_compendium: two-stage semantic search (bi-encoder recall + cross-encoder rerank) over the user's compendium. Pass include_archived=true to also search archived/excluded pages (business lookups, navigation/search pages, deduped or manually-removed pages); the default (false) searches only the curated, in-graph pages. Result lines carry a page id ([id=123]) when resolvable -- pass it to get_page_detail for the full page content.

  Read the result markers before answering:
  - No marker: a normal relevance-ranked hit. Cite it directly.
  - "[archived]": sourced from an archived/excluded page, not the active compendium -- say so explicitly if you use it.
  - "[low-confidence]": semantically related to the query but below the confidence threshold -- these are candidates, not confirmed answers. Only use them if genuinely relevant to the question, and flag the uncertainty.
  - "Taxonomy match: ...": the query matched a cluster or supercluster NAME, not page content -- it means the user's compendium HAS a topic area with this name, and lists its member pages. This is a structural fact, not a content-relevance ranking; describe what the topic area covers rather than claiming the listed pages individually rank as top search hits.
  - "No relevant matches: ... this topic appears absent ...": a diagnosed absence, not a generic failure. The numbers (candidates evaluated, best scores) tell you how close the nearest content came; use that to judge whether a rephrase is worth trying.
- list_clusters: overview of all topic clusters and superclusters, grouped by supercluster, with page counts. Use when the user asks about their compendium structure or about the graph itself, or to name the nearest topic areas the user DOES have after a genuine absence.
- get_cluster_info: pages within a specific cluster or supercluster (matched by name, with typo tolerance). Use when search already surfaced relevant pages and you need broader context within the topic, or to explore further after a taxonomy match.
- get_page_detail: full content for a single page, by id (search results and cluster listings both carry ids). Use when a chunk preview is insufficient to answer.

Strategy (stop calling tools as soon as you can answer):
Never announce a search or a check in prose -- "let me look", "one moment", "I'll search" and the like are forbidden as a final turn. The only way to look something up is to call the tool in the SAME turn you would otherwise have narrated it. An answer that makes no tool call is sent to the user exactly as written, so it is final: it must already be grounded in a prior tool result, or be an in-character greeting or out-of-scope/scope reply -- never a promise to look later.
1. Meta questions about the compendium or the graph ITSELF -- "what am I looking at", "what does this graph show", "what is in here", "what topics do I have", "how many clusters are there" -- are answered with list_clusters (ONCE), not search_compendium. Describe their actual topic areas and counts; do not search for the words of the question.
2. Otherwise, call search_compendium ONCE with the user's query.
3. Read the result markers (above) and synthesize the answer. Do NOT call additional tools unless the question genuinely requires content from a page you do not yet have, or the result was a taxonomy match needing follow-up.
4. On a genuine absence (a diagnosed "No relevant matches" with no taxonomy or low-confidence hit): optionally call list_clusters ONCE to name the nearest topic areas the user's compendium DOES cover, optionally reformulate the query ONCE into a more specific multi-word phrasing and search again, and only then tell the user the compendium has nothing on the topic. You may then offer 1-2 authoritative external starting points (e.g. a Wikipedia URL), clearly labeled as external.
5. If the user explicitly asks to search everything or archived content, or says they know it is there, call search_compendium with include_archived=true.

When answering:
- Lead with the answer in the first sentence. No preamble sentence about the compendium having relevant information ("Your compendium has some pages on this...", "I found some relevant results...") -- state the answer, then support it.
- Cite compendium sources as [Page Title](URL) as you use each one, not batched at the end.
- Label [archived], [low-confidence], and taxonomy-match results clearly per the marker guidance above; never present them as ordinary top-relevance hits.
- Ground every compendium claim in content actually returned by tools. Do NOT fall back on training-data knowledge to fill gaps; if the compendium does not have it, say so.
- No closing offer ("let me know if you'd like more detail", "want me to look further?") unless the result was a genuine absence -- a real answer ends when it is answered.

Out of scope: some questions are outside what you can do -- general knowledge, coding help, current events, math, anything unrelated to this person's captured browsing. Stay in character. Say plainly what you are -- a search agent over the pages THEY captured, with no web access and no tools beyond their compendium -- and offer the nearest thing you can do (search the compendium for that topic, or name the topic areas they do have). One or two sentences. No apology spiral, and never break frame into a general-purpose assistant.""",
        "techniques": ["instruction", "tool_use", "react", "self_awareness", "anti_hedging"],
        "description": (
            "Anti-hedging variant of agent_system_v2 (2026-09-26). A "
            "prod-mode chat pass on the demo corpus got \"let me check "
            "that for you...\" as the FINAL turn on a plain corpus "
            "question -- the model narrated an intent to search instead "
            "of calling search_compendium, and the ReAct loop "
            "(agent.py query()/query_stream()) treats any no-tool-call "
            "assistant message as done, so the hedge shipped as the "
            "answer with zero sources. v3 adds two things over v2, both "
            "confined to named sections: (a) under Strategy, an explicit "
            "never-announce-a-search rule stating that a no-tool-call "
            "answer is final and must therefore already be grounded or be "
            "an in-character greeting/scope reply; (b) under 'When "
            "answering', tightened style rules -- lead with the answer in "
            "the first sentence, cite inline as sources are used, no "
            "preamble sentence about the compendium having relevant "
            "information, no closing offer unless the result was a "
            "genuine absence. Everything else (the 'Where you live' "
            "product self-awareness framing, tool/marker/citation "
            "discipline, the numbered Strategy routing steps, the "
            "out-of-scope block) is byte-identical to v2 -- see "
            "tests/test_agent_prompt_v3.py's structural-diff assertions. "
            "Pairs with the module-level narrated-intent guard in "
            "backend/services/agent.py (_narrates_intent /"
            " NARRATED_INTENT_PHRASES), which forces one extra tool-call "
            "round on the SAME hedge shape as a loop-level backstop -- "
            "this prompt is the instruction-level half of that fix. "
            "Default since 2026-09-28: the 12-question demo-regression "
            "measurement (scripts/agent_regression.py) showed v2 and v3 "
            "level on tool use, with the loop guard closing the one gap; "
            "flipping to \"v2\" is the no-deploy env-var rollback."
        ),
    },
    "agent_system_v4": {
        "template": """You are the compendium's built-in chat -- a personal research librarian for the user's browsing compendium: a collection of web pages captured across many browsing sessions, organized into topic clusters (and topic-labeled superclusters) by an ML pipeline.

Where you live: you are embedded in the Compendium app, directly beneath the user's topic constellation -- a force-directed star-map of their own browsing. Each dot is a page they captured; dots group into named topic clusters (the labeled, glowing regions); related clusters group into superclusters; and pages that fit no cluster appear as unclustered "noise" points the user can toggle on and off. The sources you cite render as clickable pills that light up the matching node on that graph. So "node" and "dot" mean a captured PAGE, while a cluster is the named grouping pages fall into -- when the user asks how many of something there are, be explicit about which you are counting.

So when the user says "this graph", "here", "what am I looking at", "these clusters", or "the map", they mean that constellation of their own browsing sitting directly above this chat. You know what it is -- never say you cannot see images, and never ask them to describe or clarify which graph they mean. Answer with your tools: call list_clusters and describe the actual topic areas and counts in front of them, not the interface in the abstract. Keep the orientation SHORT -- a sentence or two on what the constellation is and how many topic areas it holds, then the handful of largest or most distinctive ones by name. Never dump the full cluster listing; offer to go deeper instead. A direct counting question ("how many X are there") just gets the number and what it counts -- no topic list appended.

A bare greeting gets one in-character sentence about what you can do with their compendium -- no tool call, and never a generic "how can I assist you today?".

Prior conversation turns may be included before the current question -- use them to resolve follow-up references (e.g. "it", "that topic", "the second one") to what was already discussed.

Your tools:
- search_compendium: two-stage semantic search (bi-encoder recall + cross-encoder rerank) over the user's compendium. Pass include_archived=true to also search archived/excluded pages (business lookups, navigation/search pages, deduped or manually-removed pages); the default (false) searches only the curated, in-graph pages. Result lines carry a page id ([id=123]) when resolvable -- pass it to get_page_detail for the full page content.

  Read the result markers before answering:
  - No marker: a normal relevance-ranked hit. Cite it directly.
  - "[archived]": sourced from an archived/excluded page, not the active compendium -- say so explicitly if you use it.
  - "[low-confidence]": semantically related to the query but below the confidence threshold -- these are candidates, not confirmed answers. Only use them if genuinely relevant to the question, and flag the uncertainty.
  - "Taxonomy match: ...": the query matched a cluster or supercluster NAME, not page content -- it means the user's compendium HAS a topic area with this name, and lists its member pages. This is a structural fact, not a content-relevance ranking; describe what the topic area covers rather than claiming the listed pages individually rank as top search hits.
  - "No relevant matches: ... this topic appears absent ...": a diagnosed absence, not a generic failure. The numbers (candidates evaluated, best scores) tell you how close the nearest content came; use that to judge whether a rephrase is worth trying.
- list_clusters: overview of all topic clusters and superclusters, grouped by supercluster, with page counts. Use when the user asks about their compendium structure or about the graph itself, or to name the nearest topic areas the user DOES have after a genuine absence.
- get_cluster_info: pages within a specific cluster or supercluster (matched by name, with typo tolerance). Use when search already surfaced relevant pages and you need broader context within the topic, or to explore further after a taxonomy match.
- get_page_detail: full content for a single page, by id (search results and cluster listings both carry ids). Use when a chunk preview is insufficient to answer.

Strategy (stop calling tools as soon as you can answer):
Never announce a search or a check in prose -- "let me look", "one moment", "I'll search" and the like are forbidden as a final turn. The only way to look something up is to call the tool in the SAME turn you would otherwise have narrated it. An answer that makes no tool call is sent to the user exactly as written, so it is final: it must already be grounded in a prior tool result, or be an in-character greeting or out-of-scope/scope reply -- never a promise to look later.
1. Meta questions about the compendium or the graph ITSELF -- "what am I looking at", "what does this graph show", "what is in here", "what topics do I have", "how many clusters are there" -- are answered with list_clusters (ONCE), not search_compendium. Describe their actual topic areas and counts; do not search for the words of the question.
2. Otherwise, call search_compendium ONCE with the user's query.
3. Read the result markers (above) and synthesize the answer. Do NOT call additional tools unless the question genuinely requires content from a page you do not yet have, or the result was a taxonomy match needing follow-up.
4. On a genuine absence (a diagnosed "No relevant matches" with no taxonomy or low-confidence hit): optionally call list_clusters ONCE to name the nearest topic areas the user's compendium DOES cover, optionally reformulate the query ONCE into a more specific multi-word phrasing and search again, and only then tell the user the compendium has nothing on the topic. You may then offer 1-2 authoritative external starting points (e.g. a Wikipedia URL), clearly labeled as external.
5. If the user explicitly asks to search everything or archived content, or says they know it is there, call search_compendium with include_archived=true.

When answering:
- Lead with the answer in the first sentence. No preamble sentence about the compendium having relevant information ("Your compendium has some pages on this...", "I found some relevant results...") -- state the answer, then support it.
- Answer from the pages, not around them: when a claim comes from a page, name the page in the sentence that makes the claim and cite it there as [Page Title](URL) -- e.g. "The [Classifier-Free Diffusion Guidance](URL) paper drops the classifier by ...". Never batch citations into a trailing "for more details, see ..." sentence, and never cite the same page more than twice in one answer.
- Label [archived], [low-confidence], and taxonomy-match results clearly per the marker guidance above; never present them as ordinary top-relevance hits.
- Ground every compendium claim in content actually returned by tools. Do NOT fall back on training-data knowledge to fill gaps; if the compendium does not have it, say so.
- Prefer the specific over the generic: quote or paraphrase what the captured page actually says (its figures, terms, examples) over textbook summaries of the topic.
- No closing offer ("let me know if you'd like more detail", "want me to look further?") and no "In summary"/"Thus, ..." recap paragraph -- a real answer ends when it is answered. The only exception is a genuine absence, where one sentence may offer the nearest thing the compendium does have.

Out of scope: some questions are outside what you can do -- general knowledge, coding help, current events, math, anything unrelated to this person's captured browsing. Stay in character. Say plainly what you are -- a search agent over the pages THEY captured, with no web access and no tools beyond their compendium -- and offer the nearest thing you can do (search the compendium for that topic, or name the topic areas they do have). One or two sentences. No apology spiral, and never break frame into a general-purpose assistant.""",
        "techniques": ["instruction", "tool_use", "react", "self_awareness", "anti_hedging", "inline citation at the claim"],
        "description": (
            "Answer-style variant of agent_system_v3 (2026-09-28). A "
            "12-question demo-corpus measurement of v3 showed the "
            "citation batched into a trailing \"for more details, you can "
            "refer to ...\" sentence in 6 of 12 answers, one answer citing "
            "the same page four times, and an \"In summary\" recap "
            "paragraph. v4 changes ONLY the 'When answering:' bullet "
            "block: cite at the claim by naming the page in the sentence "
            "that makes it, never batch citations into a trailing "
            "sentence, cap repeat citations of one page at two, prefer "
            "what the captured page actually says over textbook "
            "summaries, and no closing offer or recap paragraph except "
            "on a genuine absence. Everything else is byte-identical to "
            "v3 -- see tests/test_agent_prompt_v4.py's exact-diff "
            "assertion. settings.agent_system_prompt_version default is "
            "unchanged."
        ),
    },
    # =========================================================================
    # Cluster Naming (ClusteringService._build_naming_prompt)
    # =========================================================================
    "cluster_naming_v1a": {
        "template": (
            "Name this cluster of {n_pages} web pages based on the DOMINANT topic.\n\n"
            "Pages:\n{context}\n\n"
            "Rules:\n"
            "- Focus on the subject matter, not the platform "
            "(e.g., 'Volcanic Eruptions' not 'Wikipedia Articles', "
            "'Figure Skating' not 'Reddit Discussions').\n"
            "- If pages span unrelated topics, name the most common one "
            "and ignore outliers.\n"
            "- Be specific: 'Phreatomagmatic Eruptions' not 'Science Topics', "
            "'Deck Box Organizers' not 'Gaming Resources'.\n"
            "- BAD names: 'Web Search Queries', 'Diverse Online Resources', "
            "'Reddit Discussions', 'Wikipedia and Related Resources'.\n"
            "- 2-5 words. Output ONLY the name, nothing else."
        ),
        "techniques": ["instruction"],
        "description": (
            "Cluster-naming prompt for ClusteringService._name_one_cluster / "
            "_name_clusters_batch. Registry migration of the original inline "
            "f-string (clustering-quality backlog, 2026-08-14) -- byte-"
            "identical to the pre-migration prompt for identical (n_pages, "
            "context) inputs (pinned by tests/test_prompts.py). Rendered via "
            "``get_prompt_raw()``, not ``get_prompt()`` -- see that helper's "
            "docstring for why (the sanitize-and-wrap step in ``get_prompt()`` "
            "would inject ``<user_content>`` tags around ``context`` for any "
            "real multi-page cluster, breaking byte-identical parity with the "
            "original unsanitized f-string; this is not a new exposure, the "
            "original inline prompt was never sanitized either)."
        ),
    },
    "cluster_naming_v1b": {
        "template": (
            "Name this cluster of {n_pages} web pages with the topic that "
            "covers ALL of them -- not just the most salient or largest "
            "subset.\n\n"
            "Pages:\n{context}\n\n"
            "Rules:\n"
            "- Focus on the subject matter, not the platform "
            "(e.g., 'Volcanic Eruptions' not 'Wikipedia Articles', "
            "'Figure Skating' not 'Reddit Discussions').\n"
            "- Breadth over salience: when the pages are different facets of "
            "one broader subject, name the BROADER subject, not the single "
            "most prominent facet. Bad: 'Largest Fish Species' when other "
            "pages cover fish anatomy, taxonomy, or extinction, not just "
            "size records -- a broader label like 'Fish Species and Biology' "
            "covers them all. Bad: 'Philosophy of Knowledge and Existence' "
            "when other pages are about cosmology or astrobiology, not "
            "epistemology -- a broader or dual-topic label covers them all. "
            "Ask: would every page's topic recognize itself in this name?\n"
            "- If pages span genuinely unrelated topics (not facets of one "
            "subject), name the most common one and ignore outliers.\n"
            "- Be specific: 'Phreatomagmatic Eruptions' not 'Science Topics', "
            "'Deck Box Organizers' not 'Gaming Resources'.\n"
            "- BAD names: 'Web Search Queries', 'Diverse Online Resources', "
            "'Reddit Discussions', 'Wikipedia and Related Resources'.\n"
            "- 2-5 words. Output ONLY the name, nothing else."
        ),
        "techniques": ["instruction", "breadth_guidance"],
        "description": (
            "Breadth-guided variant of cluster_naming_v1a (clustering-"
            "quality backlog, 2026-08-14). v1a's 'DOMINANT topic' framing is "
            "prone to naming the most salient subset of a cluster rather "
            "than a label that covers every member page -- 'Largest Fish "
            "Species' and 'Philosophy of Knowledge and Existence' were "
            "historically produced (runs <=168) on the page-mixes preserved "
            "as fixtures 9740 (fish anatomy/taxonomy/extinction, not just "
            "size) and 9763 (epistemology/mythology mixed with cosmology/"
            "astrobiology) in "
            "evaluation/fixtures/cluster_naming/run171_v0.1.jsonl. v1b "
            "keeps the same 2-5-word / platform-avoidance / outlier-"
            "ignoring discipline as v1a but adds an explicit breadth rule "
            "with both historical failure names spelled out as BAD "
            "examples. Run-171 v1a output on these same page-mixes does "
            "NOT currently reproduce the literal failure names (see "
            "naming-candidates.md in the backlog plan folder) -- the BAD "
            "examples guard against a real, previously-observed failure "
            "class, not a live reproduction on this exact fixture set."
        ),
    },
    # =========================================================================
    # Supercluster Suggested-Group Label (super_cluster_service._suggest_group_labels)
    # =========================================================================
    "supercluster_label_v1a": {
        "template": (
            "Each entry below is a GROUP of related web-page clusters from one "
            "person's browsing. Give each group a short topic label (2-4 words, "
            "title case) that covers all its clusters — the label is offered to "
            "the user as a suggested new topic, so prefer the natural umbrella "
            "term over a list.\n\n"
            "GROUPS (JSON):\n{groups_json}\n\n"
            "Return JSON ONLY in this exact shape:\n"
            '{{"labels": [{{"group_id": <id>, "label": "<label>"}}, ...]}}'
        ),
        "techniques": ["instruction", "json_mode"],
        "description": (
            "Suggested-group label prompt for "
            "super_cluster_service._suggest_group_labels. Registry migration "
            "of the original inline prompt string (clustering-quality "
            "backlog, 2026-08-14) -- byte-identical to the pre-migration "
            "prompt for identical (groups_json) input (pinned by "
            "tests/test_prompts.py). ``sibling_labels_block`` is accepted "
            "by the render call but unused here -- this template has no "
            "placeholder for it, so it is silently dropped by "
            "``get_prompt_raw()``. Rendered via ``get_prompt_raw()``, not "
            "``get_prompt()``, for the same byte-identical-parity reason as "
            "``cluster_naming_v1a`` (see that entry's description) -- "
            "``groups_json`` routinely exceeds the 50-char sanitize-wrap "
            "threshold, and this template also embeds a literal JSON-shape "
            "example that ``get_prompt()``'s brace-escaping kwarg path was "
            "never exercised against."
        ),
    },
    "supercluster_label_v1b": {
        "template": (
            "Each entry below is a GROUP of related web-page clusters from one "
            "person's browsing. Give each group a specific topic label: a "
            "2-4 word noun phrase (title case) that covers all its clusters "
            "-- the label is offered to the user as a suggested new topic, "
            "so prefer the natural umbrella term over a list.\n\n"
            "Rules:\n"
            "- 2-4 words, a specific noun phrase -- never a bare one-word "
            "academic discipline ('Zoology', 'Technology', 'Science') and "
            "never a brand or product name alone ('Obsidian', 'Claude'). "
            "Name the TOPIC the group's pages are about, not the field or "
            "platform it happens to sit in (e.g. 'Cephalopod Behavior' not "
            "'Zoology', 'Password Managers' not 'Technology', 'Obsidian "
            "Plugin Development' not 'Obsidian').\n"
            "- Distinctive: the label must be clearly different from every "
            "OTHER group label below AND from these already-assigned labels "
            "in the same run:\n{sibling_labels_block}\n"
            "Two groups covering genuinely different topics must never get "
            "labels that could be confused for each other.\n\n"
            "GROUPS (JSON):\n{groups_json}\n\n"
            "Return JSON ONLY in this exact shape:\n"
            '{{"labels": [{{"group_id": <id>, "label": "<label>"}}, ...]}}'
        ),
        "techniques": ["instruction", "json_mode", "distinctiveness_guidance"],
        "description": (
            "Specificity-and-distinctiveness variant of "
            "supercluster_label_v1a (clustering-quality backlog, "
            "2026-08-14). Targets two observed failure modes: bare one-word "
            "discipline labels ('zoology', 'technology', 'science') that "
            "read as a field name rather than a topic, and brand-only "
            "labels; and label collisions across groups in the same run. "
            "``sibling_labels_block`` is a rendered list of the run's "
            "OTHER already-known group labels (declared/keyword-matched "
            "groups that didn't need LLM naming) -- passed by the caller "
            "in ``assign_super_clusters_hybrid`` where that context is in "
            "scope; groups being named in the SAME batched call are "
            "already visible to the model via the GROUPS JSON payload, so "
            "this covers the sibling groups that would otherwise be "
            "invisible."
        ),
    },
}


# =============================================================================
# Helper Functions
# =============================================================================

import json as _json
from pathlib import Path as _Path

_OVERRIDES_PATH = _Path(__file__).resolve().parent / "overrides.json"


def _overrides_path() -> _Path:
    """Where overrides are read from.

    ``settings.prompt_overrides_path`` when set: a deployment-local file
    outside the repo, which the Prompts dev view's editor writes. Otherwise
    the tracked ``overrides.json`` beside this module (kept empty in git) as
    the read fallback. ``_OVERRIDES_PATH`` is read at call time so tests can
    monkeypatch it.
    """
    from backend.config.settings import settings

    configured = (settings.prompt_overrides_path or "").strip()
    return _Path(configured).expanduser() if configured else _OVERRIDES_PATH


def _load_overrides() -> dict:
    """Read the override map. Returns {} if missing or invalid.

    Called on every ``get_prompt()`` so edits via the Prompts dev view
    take effect without restarting the server.
    """
    path = _overrides_path()
    if not path.exists():
        return {}
    try:
        data = _json.loads(path.read_text(encoding="utf-8"))
    except (_json.JSONDecodeError, OSError):
        return {}
    return data if isinstance(data, dict) else {}


def get_prompt(name: str, **kwargs) -> str:
    """
    Get a formatted prompt by name.

    Checks ``overrides.json`` for a live override before falling back to
    the ``PROMPTS`` dict, sanitizes all string kwargs to prevent Python
    .format() injection (e.g., ``{0.__class__}``), and wraps long values
    in ``<user_content>`` delimiters to reduce LLM prompt injection risk.

    Args:
        name: Prompt template name
        **kwargs: Values for template placeholders

    Returns:
        Formatted prompt string

    Raises:
        KeyError: If prompt name not found
        KeyError: If required placeholder not provided
    """
    from backend.utils.sanitize import sanitize_prompt_input

    if name not in PROMPTS:
        raise KeyError(f"Prompt template '{name}' not found. Available: {list(PROMPTS.keys())}")

    overrides = _load_overrides()
    template = overrides.get(name) or PROMPTS[name]["template"]

    # Sanitize all string-valued kwargs before interpolation
    safe_kwargs = {}
    for key, value in kwargs.items():
        if isinstance(value, str):
            safe_kwargs[key] = sanitize_prompt_input(value)
        else:
            safe_kwargs[key] = value

    try:
        return template.format(**safe_kwargs)
    except KeyError as e:
        raise KeyError(f"Missing placeholder {e} for prompt '{name}'")


def get_prompt_raw(name: str, **kwargs) -> str:
    """Get a formatted prompt by name, WITHOUT ``get_prompt()``'s sanitize-
    and-wrap step (brace-escaping + ``<user_content>`` delimiters for any
    string kwarg over 50 chars).

    Still checks ``overrides.json`` first, same as ``get_prompt()`` -- the
    Models dev view's hot-reload story is preserved. The only difference is
    that kwargs are interpolated as-is via plain ``str.format()``.

    Use this ONLY for prompts migrated from pre-registry inline f-strings
    where byte-identical rendered output is a correctness requirement (e.g.
    ``cluster_naming_v1a``, ``supercluster_label_v1a`` -- both pinned by
    tests/test_prompts.py against their original literal strings). Reaching
    for ``get_prompt()``'s sanitize-and-wrap on one of those templates would
    silently change the rendered prompt (and therefore model behavior) the
    moment any interpolated value exceeds 50 chars, which is the common
    case for multi-page cluster listings and JSON group payloads. This
    function does not introduce a new injection-safety regression relative
    to those templates' pre-migration behavior -- the original inline
    f-strings were never sanitized either; it simply preserves that
    behavior inside the registry instead of quietly hardening it.

    New prompts that don't have a byte-identical-parity constraint should
    prefer ``get_prompt()`` for its injection defenses.

    Args:
        name: Prompt template name
        **kwargs: Values for template placeholders. Extra kwargs not
            referenced by the template are silently ignored (plain
            ``str.format()`` semantics); a placeholder with no matching
            kwarg raises ``KeyError``.

    Returns:
        Formatted prompt string

    Raises:
        KeyError: If prompt name not found
        KeyError: If a template placeholder has no matching kwarg
    """
    if name not in PROMPTS:
        raise KeyError(f"Prompt template '{name}' not found. Available: {list(PROMPTS.keys())}")

    overrides = _load_overrides()
    template = overrides.get(name) or PROMPTS[name]["template"]

    try:
        return template.format(**kwargs)
    except KeyError as e:
        raise KeyError(f"Missing placeholder {e} for prompt '{name}'")


def get_prompt_template(name: str) -> str:
    """Return the UNFORMATTED template text for ``name`` -- the live override
    from ``overrides.json`` if one exists, else the registry entry. Used by
    read-only surfaces that display a prompt (Pipeline dev view's skip-gate
    config panel; the Prompts dev view) without rendering it.

    Raises:
        KeyError: If prompt name not found
    """
    if name not in PROMPTS:
        raise KeyError(f"Prompt template '{name}' not found. Available: {list(PROMPTS.keys())}")
    overrides = _load_overrides()
    return overrides.get(name) or PROMPTS[name]["template"]


def list_prompts() -> list[dict]:
    """List all available prompts with metadata."""
    return [
        {
            "name": name,
            "techniques": data["techniques"],
            "description": data["description"],
        }
        for name, data in PROMPTS.items()
    ]


def get_prompts_by_task(task: str) -> list[dict]:
    """List all prompt versions for a given task prefix (e.g., 'page_summary')."""
    return [
        {
            "name": name,
            "techniques": data["techniques"],
            "description": data["description"],
        }
        for name, data in PROMPTS.items()
        if name.startswith(task)
    ]


def get_prompt_metadata(name: str) -> dict:
    """Get metadata for a specific prompt without formatting it."""
    if name not in PROMPTS:
        raise KeyError(f"Prompt template '{name}' not found. Available: {list(PROMPTS.keys())}")
    return {
        "name": name,
        "techniques": PROMPTS[name]["techniques"],
        "description": PROMPTS[name]["description"],
    }
