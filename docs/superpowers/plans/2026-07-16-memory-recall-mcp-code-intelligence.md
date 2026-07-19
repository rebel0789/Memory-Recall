# Read-Only MCP Code Intelligence Implementation Plan

> Execute with contract tests first. All outputs must stay bounded, workspace-locator-safe, and free of raw source bodies.

**Goal:** Expand the MCP surface from five to twelve useful tools by exposing and composing the native source graph.

**Architecture:** Add pure intelligence helpers under `packages/source-graph/src/` and thin validation/transport handlers in `apps/cli/oaf.mjs`. Reuse `buildSourceGraphPreview`, `searchSourceGraph`, `traceSourceGraph`, `mapSourceGraphDiffImpact`, `rankArchitectureNodes`, and the orientation model. Do not duplicate parsers in the MCP layer.

## Task 1: Shared graph delivery and validation

**Files:** `packages/source-graph/src/intelligence.mjs`, `packages/source-graph/src/index-store.mjs`, `apps/cli/oaf.mjs`, `tests/source-graph-intelligence.test.mjs`, `tests/mcp-token-saver.test.mjs`

1. Add failing tests for bounded enum/list/string arguments and locator normalization.
2. Add a shared graph loader that prefers a valid read-only persisted index and otherwise performs the existing bounded in-memory scan without writing.
3. Return source, freshness, coverage, and safeguard metadata with every structural response.
4. Run focused tests to green.

## Task 2: Architecture and index status

1. Add failing MCP contract tests for `repo.architecture` and `repo.index_status`.
2. Implement architecture groups, ranked entry points, hotspots, relationship counts, and coverage from sanitized graph data.
3. Implement index status as metadata-only inspection; absent and stale indexes are valid states, not implicit refresh triggers.
4. Verify both tools report `read-only` and zero local writes.

## Task 3: Search, context, and trace

1. Add failing tests for `code.search`, `code.context`, and `code.trace`, including ambiguous symbols, direction/depth bounds, pagination, and locator prefixes.
2. Implement search as a compact wrapper over `searchSourceGraph`.
3. Implement context as one selected node plus bounded incoming/outgoing edges, containing file/chunk, callers, callees, references, and ambiguity candidates.
4. Implement trace over `traceSourceGraph` with terminal locators and bounded paths.
5. Assert raw fixture source does not appear in any response.

## Task 4: Dependencies and routes

1. Add failing tests for `code.dependencies` on file, module, and symbol starting points.
2. Add failing route tests for conventional server route files and handler symbols, including no-route results.
3. Implement dependency traversal over import, contains, defined-in, call, and reference edges with explicit relation kinds.
4. Implement route discovery as evidence-based ranking using file patterns, handler/export signals, and connected graph nodes. Label it static discovery, not runtime tracing.
5. Run focused tests to green.

## Task 5: Impact integration and tool manifest

1. Extend `code.impact` tests for risk summary, direct/transitive counts, unrepresented changes, and freshness.
2. Update the MCP manifest and reference descriptions to exactly twelve tools.
3. Run MCP inspection and smoke tests against a temporary multi-file repository.
4. Verify every structural tool is read-only, bounded, locator-only, and deterministic for a fixed clock.
