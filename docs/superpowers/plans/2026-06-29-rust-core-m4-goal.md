# Codex goal — OAF Rust supertool, Milestone M4: retrieval & query layer

Date: 2026-06-29. Owner: rebel. Runtime: long autonomous run (overnight ok).
Authoritative design: `docs/product/oaf-rust-supertool-spec.md` (esp. §7.6 Cypher pitfalls).
Predecessor: M3 (branch `codex/rust-core-m3`, tree-sitter governed ingest). Build M4 ONLY.

## 0. Mission
Add the query layer over the governed/temporal graph M3 produces: multi-hop graph path,
neighborhood explain, a minimal-but-CORRECT Cypher subset (with temporal `AS OF`), and a
one-call architecture overview. No model, no network. Three verification modes apply
(read §4 — they differ per surface). Stop at the definition of done or the first blocker.

## STEP 0 — base correctly
Branch off `codex/rust-core-m3`. New worktree `codex/rust-core-m4`. Re-run the existing
parity + ingest-quality harnesses; M1/M2/M3 must still pass before adding M4.

## 1. Repo & build isolation (unchanged)
All code under `/rust`. Do NOT modify Node files except the existing harnesses. Node
`npm run ci` (435) stays green. Own CI job. No network/model at runtime.

## 2. Scope — IN vs OUT
IN: graph.path (multi-hop BFS; --max-hops, --undirected, temporal --at); graph.explain
(k-hop neighborhood; --depth, temporal); query.graph (Cypher minimal subset + AS OF);
architecture.overview (one call). All read-only, current-truth filtered, exposed via BOTH
the CLI and MCP tools. 
OUT (scope violation if built): semantic/vector search (separate later opt-in milestone —
needs the embedding-table sourcing decision), loop runtime, UI, install, cross-repo, more
ingestion languages, write tools over MCP.

## 3. What to build
### 3.1 graph.path / graph.explain
Port + extend Node's `memory path` / `memory explain` (which exist on the graph-ui base).
Add a temporal `--at <ts>` that filters edges to those valid at that time (supersession-
aware). Current-truth by default. Path returns ordered nodes + edges with predicate +
fact_id; explain returns the k-hop subgraph.
### 3.2 query.graph — Cypher (apply cbm §7.6 discipline strictly)
A SMALL, fully-specified subset with a real grammar and a conformance test PER feature:
`MATCH (n:Label)-[:REL]->(m)`, `WHERE` (property compares, `n:Label` label test, AND/OR/
NOT), `RETURN` (properties, `AS` alias, `labels(n)`, `count(*)`, `count(DISTINCT x)`),
`WITH`, `DISTINCT` (applied BEFORE order/limit), `ORDER BY`, `LIMIT`, `toInteger()`. Plus
temporal `AS OF <ts>`. RULES: error CLEARLY on any unsupported syntax — NEVER silently
return a blank/partial/wrong result (cbm #373); DISTINCT/ORDER BY/LIMIT execution order
must be correct (cbm #237); every supported feature has a passing test AND an
unsupported-syntax test asserting a clear error.
### 3.3 architecture.overview
One read-only call over the governed graph returning: language histogram, top modules/
packages, entry points, hotspots (top-degree symbols), Louvain communities (label + size),
and governed decisions (`decision`/`adr` facts). Compact, token-efficient (labels/counts,
not bodies). Current-truth filtered.

## 4. Verification — THREE modes (do not conflate)
- graph.path / graph.explain: BYTE-PARITY with Node (Node has these) on the notes-api +
  OAF-self-ingest graphs. Extend the parity harness.
- query.graph (Cypher): CORRECTNESS suite (Node has no Cypher oracle). A test per supported
  feature on a known fixture graph with exact expected rows; an error test per unsupported
  construct. NO silent wrong/blank results.
- architecture.overview: QUALITY on the real OAF graph (assert language histogram non-empty,
  >1 community, hotspots include the known hub, decisions list non-empty, payload materially
  smaller than dumping all facts).
Temporal: a test that supersedes a fact, then asserts `AS OF <past>` returns the old edge
and current returns the new (path, explain, and Cypher).

## 5. Memory & safety (carry M1-M3 invariants)
Read-only queries; bounded result sizes (cap rows/nodes with a clear truncation flag — never
silent); no O(n²) blowups on a high-degree hub; current-truth filtering excludes superseded.

## 6. Benchmark
path / explain / Cypher / architecture latency + RSS on the real OAF graph (22k facts).
Report a table. Real numbers.

## 7. Checkpoint protocol & stop conditions
Commit per green `cargo build && cargo test && node scripts/<harnesses>`. Stop at the first
blocker you can't resolve cleanly; report it. No `unsafe` without justification + test.
Stay in scope (no semantic search).

## 8. Definition of done
- [ ] Step 0: based on rust-core-m3; M1/M2/M3 still pass.
- [ ] graph.path/explain byte-parity with Node (+ temporal --at).
- [ ] Cypher subset: every supported feature tested with exact rows; unsupported syntax
      errors clearly; DISTINCT/order/limit order correct; AS OF works.
- [ ] architecture.overview quality-verified on the real OAF graph.
- [ ] All exposed via CLI + MCP; read-only; current-truth filtered.
- [ ] Benchmark table; Node `npm run ci` green (435); Node untouched except harnesses.
- [ ] Honest report: parity results, Cypher feature coverage (supported vs explicitly
      unsupported), architecture sample, bench, open questions.

## 9. Reporting
End with: parity table (path/explain), Cypher feature matrix (supported + error-tested),
architecture.overview sample for the OAF graph, benchmark table, DoD checklist, and an
explicit "unsupported / open questions" list. Real numbers only.
