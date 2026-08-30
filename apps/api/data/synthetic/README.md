# Synthetic Sessions

LLM-crafted browsing sessions archived for provenance. Schema matches the raw session format (`sessionId`, camelCase fields, `isTrackedDomain`).

## Session Descriptions

| File | Name | Type | Description |
|------|------|------|-------------|
| `session_001.json` | Titanic Disaster | Short (3 pages) | Linear path from Titanic to cold-related injuries |
| `session_002.json` | Black Holes | Deep dive (6 pages) | Focused exploration of black hole physics |
| `session_003.json` | Coffee to Mardi Gras | Exploration (5 pages) | Meandering path following cultural/geographical connections |
| `session_004.json` | Random Jumps | Chaotic (5 pages) | Non-obvious connections between unrelated topics |
| `session_005.json` | Single Page | Edge case (1 page) | No transitions — tests single-page handling |
| `session_006.json` | Duplicate Pages | Edge case (4 pages) | Revisited page with `forward_back` qualifier |
| `session_007.json` | Speed Browsing | Edge case (6 pages) | Very short dwell times (<30s), sequential planetary browsing |

## Notes

- All pages are Wikipedia articles (`isTrackedDomain: true`).
- Ground truth annotations (expected clusters and triggers) live with the
  evaluation framework, which was not extracted into this repo (it remains in
  the private predecessor archive, at `evaluation/annotations/llm_generated.json`).
- These sessions are archival. They are not used for active evaluation of pipeline quality.
- Originally bundled as the evaluation framework's `sample_sessions.json` (v2.1, created 2024-01-19).
