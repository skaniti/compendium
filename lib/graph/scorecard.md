# F2 graph-canvas bake-off scorecard

Template for Task S4 (batch 03 graph canvas port plan). Filled in against
`/sandbox/graph-a1` and `/sandbox/graph-a2`, then copied verbatim into that
task's `results.md` at decision time -- this file itself stays an empty
template.

Criteria per the plan's spec (Fork F2): subjective feel, three measured
numbers, and three CC-run checks. Decision rule: fidelity ties -> A2 wins
only if its pan/zoom is indistinguishable from A1's AND the worker
integration is demonstrated in-sandbox; otherwise A1 wins (fidelity-first,
refactor later).

## User-scored (Task S4 Step 2)

Scale: 1-10, higher is better. Non-comparable criteria: score N/C with a
one-line reason rather than guessing a number.

| Criterion | A1: port-intact | A2: react-owned |
|---|---|---|
| Cold-load feel | | |
| Pan/zoom smoothness -- min zoom | | |
| Pan/zoom smoothness -- mid zoom | | |
| Pan/zoom smoothness -- max zoom | | |
| Select/hover latency | | |
| "Would I enjoy maintaining this" | | |

## Measured (Task S4 Step 2)

| Metric | A1: port-intact | A2: react-owned |
|---|---|---|
| Time-to-first-dots (ms) | | |
| Frame rate during pan (fps) | | |
| Heap (MB) | | |

Metric semantics: the two time-to-first-dots numbers measure different
moments — A1 marks after the fully SETTLED layout paints (synchronous vendor
pipeline); A2 marks when the phyllotaxis SEED paints, with a visible ~2s live
settle following. The difference is the architecture itself; compare the
experiences, not just the numbers. Both are dev-mode figures (StrictMode
double-mount inflates absolutes on both sides; relative comparison holds).

## CC-run checks (Task S4 Step 1)

| Check | A1: port-intact | A2: react-owned |
|---|---|---|
| Worker adoptability | | |
| Behavior diff vs Dash | | |
| A2 remaining-rebuild estimate (vs full inventory) | N/A | |

## Decision

- **Winner:**
- **Rationale:**
