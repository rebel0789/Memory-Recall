# Persistent Incremental Source Index Implementation Plan

> Execute with temporary repositories and process-restart tests. MCP reads indexes but never writes them.

**Goal:** Add a safe persistent local source-graph index that reuses unchanged file metadata and supports larger repositories without false scale claims.

**Architecture:** Persist sanitized per-file parse shards plus a merged graph and manifest. The explicit CLI writer owns mutation. The read-only loader validates schema, workspace containment, parser version, ignore identity, and freshness before serving data.

## Task 1: Per-file shard contract

**Files:** `providers/native/context-candidate-ast-code/src/index.mjs`, `packages/source-graph/src/index-store.mjs`, `tests/source-graph-index-store.test.mjs`

1. Add failing tests that a file shard contains structural metadata and hashes but no raw body.
2. Add an `onlyIncludes` scan option that prunes traversal to requested workspace-relative JS/TS files while preserving ignore and safety rules.
3. Export a safe shard builder and a merge function that rebuilds the global symbol index from merged chunks/file outlines.
4. Verify merged output matches a clean full scan for the same fixture.

## Task 2: Atomic persistent format

1. Add failing tests for schema validation, workspace-contained paths, corrupt files, parser-version mismatch, and atomic replacement.
2. Implement `index.v1.json` with schema version, workspace ID, root identity hash, scan settings, ignore fingerprint, file manifest, shards, sanitized graph, generated time, and content fingerprint.
3. Write through a same-directory temporary file, fsync/close, then rename.
4. Enforce permissions and never store absolute paths or source bodies.

## Task 3: Incremental refresh

1. Add a fixture with changed, added, deleted, and unchanged files.
2. Assert refresh parses only changed/added paths, reuses unchanged shards, removes deleted shards, and produces the same public graph as a clean full build.
3. Treat ignore-rule, parser-version, or scan-setting changes as explicit full rebuild reasons.
4. Report parsed, reused, added, changed, deleted, duration, and coverage counts without making provider token or scale claims.

## Task 4: CLI lifecycle

**Files:** `apps/cli/oaf.mjs`, `tests/cli.test.mjs`

1. Add failing help and behavior tests for `recall graph index --write`, `--refresh`, `--status`, `--out`, and `--watch`.
2. Require explicit `--write` or `--refresh` for mutation. `--status` is read-only.
3. Implement bounded debounced watch mode with clean shutdown and visible refresh results.
4. Keep the index under `.local/` by default and update ignore/setup guidance.

## Task 5: Restart, scale, and safety verification

1. Build an index, exit, load it in a new process, and verify graph fingerprint equality.
2. Call every MCP structural tool against the persisted index and assert the index mtime does not change.
3. Generate a representative large JS/TS fixture and record cold build, warm load, and one-file refresh time plus index size.
4. Document the measured fixture size and current bounds. Do not claim million-node or cross-repository support.
