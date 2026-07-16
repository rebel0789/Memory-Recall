# Memory Recall Task-First Code Intelligence Design

**Date:** 2026-07-16
**Status:** Approved for implementation

## Product decision

Memory Recall is a local developer workbench for two connected jobs:

1. understand a repository before changing it;
2. preserve and deliver trustworthy context after the work.

The first screen must answer three questions without teaching product vocabulary:

- Where should I start?
- What changed or needs attention?
- What context can I trust?

The UI remains a restrained workbench. It does not imitate a generic analytics dashboard, a graph demo, or an AI assistant. Existing native typography, off-white and graphite surfaces, cobalt interaction color, flat geometry, spacing, and accessible controls remain the design system.

## Navigation and information architecture

Use task labels in the persistent navigation while keeping short page titles:

| Navigation | Page title | Job |
| --- | --- | --- |
| Start | Overview | Orient in ten seconds |
| Explore code | Map | Find a file or symbol, inspect dependencies, and trace impact |
| Review memory | Memory | Review proposals and current governed facts |
| Prepare handoff | Handoffs | Build, pin, verify, and receive compact context |
| Settings | Settings | Inspect local paths, scan limits, privacy, and read-only guarantees |

The Overview presents a small set of direct next actions. It does not repeat the same repository status in multiple cards.

## Map behavior

The current empty-query failure is removed. Map has two valid states:

- **Repository architecture:** the default and empty-query result renders the bounded repository group graph and a group outline.
- **Focused code view:** a query, changed file, or selected group renders a smaller node graph and a matching accessible outline.

The submit label is **Search code**, because submitting a query searches the current scan. **Refresh scan** remains the explicit operation that re-reads local files.

Graph labels use progressive disclosure:

- always show the selected node;
- show immediate neighbors when space permits;
- show a bounded set of high-value labels at the default zoom;
- reveal additional labels on hover and zoom;
- never render every label merely because the graph contains fewer than an arbitrary threshold.

The outline is the legible equivalent of the canvas. Each row uses a stacked label and locator, both with controlled wrapping or ellipsis. Selection remains synchronized between canvas, outline, and inspector.

## Honest measurements

No reduction percentage is shown when the baseline is zero, absent, or not comparable. The UI says **Not measured** and explains what action produces a measurement. Local token estimates remain explicitly separate from provider billing.

## Read-only MCP surface

Expand from five to twelve focused read-only tools. Every tool returns bounded, locator-safe metadata and excludes raw source bodies.

| Tool | Purpose |
| --- | --- |
| `repo.map` | Combined bounded repository, memory, and handoff orientation |
| `repo.architecture` | Repository groups, entry points, hotspots, and coverage |
| `repo.index_status` | Persistent-index availability, freshness, limits, and coverage |
| `code.search` | Structural and lexical search across files, symbols, and relationships |
| `code.context` | One symbol or file with incoming, outgoing, containing, and related context |
| `code.trace` | Bounded inbound, outbound, or bidirectional relationship paths |
| `code.dependencies` | Direct and transitive module or file dependencies and dependants |
| `code.routes` | Route and handler entry points with connected symbols and files |
| `code.impact` | Changed-file coverage, affected symbols, and relationship evidence |
| `memory.recall` | Governed current and temporal memory facts |
| `context.profile` | Budgeted memory profile for an objective |
| `context.pack` | Sanitized handoff context |

Tool count is not the success metric. Each added tool must reuse verified source-graph primitives, provide bounded pagination or depth, retain workspace locators, and include freshness and coverage truth.

## Persistent local index

The persistent index is derived local state, never canonical memory.

- The explicit `recall graph index --write` command creates or refreshes it.
- MCP tools may read a valid index but never create, refresh, or mutate it.
- The default location is `.local/source-graph/index.v1.json`; callers may supply another workspace-contained path.
- The file contains schema/version metadata, workspace identity, scan settings, a content manifest, per-file metadata shards, and a sanitized graph. It contains no raw source bodies.
- Refresh compares content hashes and ignore-rule identity. Unchanged shards are reused; changed and added JS/TS files are rescanned; deleted shards are removed; the global symbol graph is rebuilt from the merged metadata.
- Unsupported languages and configured bounds remain visible as partial coverage. Million-node claims are prohibited until a benchmark proves them.
- Watch mode only invalidates and schedules explicit local refresh behavior. It must be bounded, debounced, and stoppable.

## Competitive boundary

GitNexus and Codebase Memory MCP remain current references for breadth, persistent indexing, and route/call-graph ergonomics. Memory Recall will not claim parity with their language counts, semantic search, cross-repository analysis, or index scale until those behaviors exist and are benchmarked here.

Memory Recall's product-owned advantage is the connection between code structure and governed temporal context: proposals, review, current truth, source evidence, cursor deltas, compact delivery, and verified handoffs.

## Acceptance criteria

- A first-time developer can identify the three main jobs from the first screen and navigation.
- Empty Map submission produces a visible repository graph, not a canvas-free state.
- A 50-100 node focused graph remains readable; outline text does not collide.
- Settings contains real runtime and privacy information, not design swatches.
- Handoffs leads with one recommended flow and public `recall` commands.
- Unmeasured savings never render as 100% reduction.
- MCP inspection lists twelve read-only tools and each new tool has focused contract tests.
- Read-only MCP calls make zero local writes.
- Explicit index creation survives process restart and refreshes changed shards without retaining raw source.
- README and reference docs state verified capabilities and explicit gaps.
- Focused tests, the full suite, browser interaction QA, and a large-repository benchmark pass before release claims.
