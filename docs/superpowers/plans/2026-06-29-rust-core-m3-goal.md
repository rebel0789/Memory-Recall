# Codex goal — OAF Rust supertool, Milestone M3: tree-sitter governed ingestion

Date: 2026-06-29. Owner: rebel. Runtime: long autonomous run (overnight ok).
Authoritative design: `docs/product/oaf-rust-supertool-spec.md` — READ IT FIRST (esp. §7.2
memory pitfalls and §7.5 extraction-quality pitfalls). Predecessor: M2 (branch
`codex/rust-core-m2`). This goal builds M3 ONLY.

## 0. Mission & the verification SHIFT (read carefully)
Replace OAF's weak heuristic ingest with real tree-sitter AST extraction that produces
GOVERNED structural facts/entities/edges (provenance + confidence + proposal-gated +
bi-temporal). UNLIKE M1/M2, the Node ingest is INFERIOR (it caused the entity-dup and
silent-truncation bugs we fixed), so M3 is NOT verified by byte-parity with Node. M3 is
verified by EXTRACTION QUALITY on real repos + the governance/temporal invariants + no
regression of the M1/M2 recall/graph behavior. This is where Rust must be BETTER than both
Node-OAF and codebase-memory-mcp, while avoiding cbm's documented failure modes (§7).

## STEP 0 — base correctly
Rebase/branch off `codex/rust-core-m2` (latest verified). New worktree `codex/rust-core-m3`.
Re-run the existing conformance harness; M1/M2 parity must still pass before adding M3.

## 1. Repo & build isolation (unchanged)
All new code under `/rust`. Vendored tree-sitter grammars compiled into the binary (their
own crate, e.g. `oaf-ingest`). Do NOT modify Node files except the existing harness. Node
`npm run ci` (435) stays green. Own CI job. No network/model at runtime.

## 2. Scope — IN vs OUT
IN: tree-sitter parse + AST extraction for a CURATED initial language set —
TypeScript/TSX, JavaScript/JSX, Python, Rust, Go (5 langs, done WELL). Extract entities
(File, Module, Function, Class/Struct, Method) and edges (DEFINES, IMPORTS, CALLS) →
governed facts/entities/edges through the proposal gate. `oaf ingest --root <repo>` command.
Integrity + memory safeguards (§5). BM25 indexing of extracted symbol/doc text via the
camel tokenizer.
OUT (scope violation if built): more than the 5 languages; HTTP/route/gRPC/IaC/k8s passes;
Hybrid-LSP type resolution; Cypher; semantic/vector search; loop; UI; install; cross-repo.
Those are later milestones — note if tempted, don't build.

## 3. Extraction quality requirements (avoid cbm's documented bugs, spec §7.5)
- CALLS edges MUST attribute to the caller Function/Method, NEVER to the Module node
  (cbm #438/#220). Cross-file calls resolve to the right symbol, not collapsed onto a
  namespace when a bare name exists in multiple packages (cbm #478).
- Entities deduped by (workspace, scope, name) — one id per name (already our invariant).
- Large files MUST NOT silently produce zero/partial nodes (cbm #213/#199/#411): if a file
  parses to fewer symbols than a sane floor given its size, flag it — never report success
  on an empty/partial extraction.
- Index identifier + doc/comment text for BM25 via the camel+ tokenizer (so recall finds
  CamelCase/snake/namespaced symbols — cbm #518/#519).
- Every extracted fact carries confidence + provenance (file + line). Low-confidence
  extractions are flagged, not silently asserted as truth.
- Honor `.gitignore` AND `.git/info/exclude`; NEVER read outside the repo root
  (cbm #331/#489). Safe temp files only.

## 4. Governance + temporal layering (our moat — cbm has none)
Extracted facts route through the proposal gate (pending → approve), carry validity
intervals, and supersede prior extractions on re-ingest (a renamed/removed symbol's fact is
retired, not duplicated). Re-ingesting an unchanged repo is idempotent (no dup facts). The
M1/M2 recall + delta + graph queries must work over the richer graph unchanged.

## 5. Memory & performance safeguards (spec §7.2 — bake in)
- This is the first BULK ingest: enforce a `--max-memory <MB>` cap (default sane, e.g.
  parse/stream in bounded batches; release per-file AST after extraction). Respect cgroup
  limits if present.
- NO O(n²) AST traversals (cbm #130/#106/#471 hung on quadratic `ts_node_child` loops):
  iterate children with cursors, not repeated index lookups. Add a test on a large
  synthetic AST asserting linear-ish time.
- Single-writer, atomic, integrity-checked writes (from M1). Crash mid-ingest leaves the DB
  clean (extend the kill-mid-write test to mid-ingest).
- Cap file descriptors; do not open the whole repo at once (cbm #70).

## 6. Verification — QUALITY, not byte-parity (THE GATE)
Add a NEW quality harness (do not weaken the existing parity harness). On REAL inputs:
- Fixture repo (small, multi-language, with a known call graph) — assert exact expected
  entities + CALLS/IMPORTS/DEFINES edges (caller→callee correct, dedup correct).
- The OAF repo itself (835 files, but only the 5 supported langs) — assert: node count is
  sane vs file count (no silent truncation), zero entities with duplicate ids, CALLS edges
  point to Functions not Modules, re-ingest is idempotent (no dup facts), recall of a known
  CamelCase symbol returns it, and a known superseded symbol is retired on re-ingest.
- Governance: all extracted facts are pending until approved; approve activates; supersession
  on re-ingest works.
Report precision/quality numbers honestly (e.g. % CALLS edges correctly attributed on the
fixture). No cherry-picking; if extraction misses a pattern, report it.

## 7. Benchmark
Index the OAF repo (5-lang subset): wall time + peak RSS, vs Node ingest baseline
(1.5s / 350MB for the heuristic ingest). Report the table. Must be materially leaner.

## 8. Checkpoint protocol & stop conditions
Commit per green `cargo build && cargo test && node scripts/<quality-harness>`. Stop at the
first blocker (e.g. a grammar integration issue) you can't resolve cleanly; report it. No
`unsafe` without justification + test. Don't exceed the 5-language scope.

## 9. Definition of done
- [ ] Step 0: based on rust-core-m2; M1/M2 parity still passes.
- [ ] tree-sitter ingest for the 5 langs; `oaf ingest` produces governed facts/entities/edges.
- [ ] Quality harness passes: correct call-graph attribution, dedup, no silent truncation,
      idempotent re-ingest, supersession on re-ingest, CamelCase recall.
- [ ] Memory safeguards: --max-memory cap, no O(n²), mid-ingest crash safety, fd cap.
- [ ] Benchmark vs Node ingest reported (leaner/faster).
- [ ] Node `npm run ci` green (435); Node untouched except the harness.
- [ ] Honest report: extraction quality numbers, what patterns are NOT yet handled, bench.

## 10. Reporting
End with: the quality harness results (with honest precision numbers + unhandled patterns),
the benchmark table, the DoD checklist, and an explicit "not yet handled / open questions"
list. Real numbers only.
