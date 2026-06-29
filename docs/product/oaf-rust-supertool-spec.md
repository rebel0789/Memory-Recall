# OAF Rust Supertool — master build spec

Status: design reference for the ground-up Rust build. The verified Node OAF is the
conformance oracle. Goal: be strictly better than codebase-memory-mcp (cbm) and every
other code-memory tool by combining cbm's structural engine with OAF's governed/temporal
brain, which cbm and the others lack.

## 0. Positioning (why this wins)

cbm is a fast native code-structure engine (tree-sitter, semantic search, Cypher, call
graphs) but has NO governance, NO bi-temporal history, NO session delta, NO loop
governance. OAF has those (verified on real repos) but a weak Node ingest. The Rust
supertool = cbm's structural goodies (matched/beaten) + OAF's brain (kept), native speed
(spike: ~9x less RAM, ~9x faster startup, 0.88ms recall vs Node).

Non-negotiable invariants: local-first, no network, no model calls by default, proposal
-gated writes, never hard-delete, single static binary.

## 1. How cbm does it (studied from source) — what to match

### 1.1 Storage / FTS (src/store/store.c)
- Flat SQLite: `projects, file_hashes, nodes, edges, project_summaries`; `nodes_fts`
  FTS5 (`unicode61 remove_diacritics 2`). Indexes on (project,label),(project,name),
  file, edge source/target/type, url_path. `PRAGMA mmap_size` for fast reads.
- **camelCase tokenizer** `sqlite_camel_split`: stores the original identifier PLUS a
  space-split copy, so FTS matches both the exact token and its word components. Rules:
  insert space (a) lowercase→uppercase (`updateCloud`→`update Cloud`), (b) uppercase-run
  →uppercase-then-lowercase (`XMLParser`→`XML Parser`). snake_case split by unicode61 on
  `_`.

### 1.2 Semantic search (src/semantic/semantic.c)
- Bundled `nomic-embed-code` as a precomputed token→int8 vector table compiled into the
  binary (no model inference, no network). Query/fact vectors = pooled token vectors;
  cosine similarity (int8, epsilon-guarded).
- **11-signal combined score**, default weights (sum ~1.0): TF-IDF 0.20, relational/graph
  -diffusion (RRI, α0.3/β0.7) 0.25, MinHash 0.10, API-signature 0.15, type-signature
  0.10, decorator 0.05, AST-struct-profile 0.10, dataflow 0.05; proximity boost ≤0.10;
  IDF base 0.5. **All signals come from graph metadata — no source-file reads at query
  time.** Edges: `SEMANTICALLY_RELATED` (vocab-mismatch ≥0.80), `SIMILAR_TO` (MinHash+LSH
  near-clone).

### 1.3 Ingestion pipeline (src/pipeline/*)
- RAM-first: parse in memory, in-memory SQLite, single dump at end, memory released after.
- Parallel passes via a registry: discover/language → tree-sitter parse → `pass_calls`
  (call graph) → `pass_pkgmap` (manifest-based package resolution) → `pass_route_nodes`
  (HTTP/gRPC/GraphQL/tRPC routes) → `pass_infrascan`/`pass_k8s` (IaC) → `pass_semantic_
  edges` → `pass_lsp_cross` (Hybrid LSP type resolution for ~9 langs) → `pass_cross_repo`.
- Incremental: file_hashes + git change detection; team-shared `graph.db.zst` (zstd,
  index-stripped, VACUUM INTO, merge=ours).

### 1.4 Query + tools
- Cypher engine (src/cypher/cypher.c) for `MATCH (f:Function)-[:CALLS]->(g) ...`.
- 14 MCP tools: index_repository, search_graph (+ semantic_query), query_graph (Cypher),
  trace_path/trace_call_path, get_code_snippet, get_graph_schema, get_architecture,
  detect_changes (impact), list_projects, index_status, manage_adr, dead-code, etc.

## 2. Where OAF is BETTER (the deltas to build in)

1. **Governed + bi-temporal store.** Every node/edge/fact carries provenance, proposal
   status, and a validity interval (valid_from/until, superseded_by). cbm's nodes/edges
   are a current snapshot with no history. We get current-truth AND "as of <time>".
2. **Proposal gate.** Writes go pending→approve→active; never silent. cbm auto-writes.
3. **Decision + WHY capture.** Governed `decision`/`adr` facts with rationale, superseding
   prior decisions. cbm has only `manage_adr` persistence.
4. **Context delta delivery.** Session-level cursor deltas (only changed facts per turn,
   with retraction) — 58–72% session token savings on real repos. cbm only cuts per-query
   tokens. We do both.
5. **Loop governance.** `loop verify` blocks a change that violates a governed decision
   even when tests pass. cbm has nothing here.
6. **Tokenizer, beaten.** Match cbm's camel split, then also: split on digit boundaries
   (`parseV2`→`parse v2`), split namespaced/colon ids (`provider:native:memory`→tokens),
   and apply it to GOVERNED FACTS, not just code symbols (cbm only tokenizes code).
7. **Temporal Cypher.** Cypher with an optional `AS OF <ts>` so graph queries respect
   supersession. cbm's Cypher is current-only.
8. **Governance-aware semantic ranking.** Same blended signals as cbm, plus boosts for
   current-truth and governed decisions; opt-in (disabled by default to keep no-model
   purity for purists).

## 3. Architecture (Rust, in-repo `/rust` workspace)

**Repo decision: SAME repo, `/rust` Cargo workspace** (not a new repo). Reason: the
conformance harness must run the Node oracle + the Rust binary against the same SQLite with
the same real scenarios co-located; a separate repo weakens that safety net. Node stays the
shipping product + oracle until Rust hits parity (M6), then flip the default. Build
isolation: `/rust` is self-contained with its own CI job; never modify package.json / the
Node CLI / existing tests; Node `npm run ci` must stay green.

Crates: `oaf-store` (rusqlite, schema, FTS, camel tokenizer, governance/temporal),
`oaf-ingest` (tree-sitter passes), `oaf-search` (BM25 + semantic + graph + Cypher),
`oaf-brain` (context delta, loop governance, architecture overview), `oaf-mcp` (stdio
JSON-RPC server + tools), `oaf` (CLI + single-binary entry). Node OAF stays until parity.

Schema (governed/temporal superset of cbm's): `facts` (bi-temporal), `entities` (identity
= workspace+scope+name — the dedup invariant), `edges` (source/target entity + predicate +
fact_id + validity), `proposals`, `episodes`, `facts_fts` (FTS5 + camel split),
`embeddings` (opt-in int8 vectors). Deterministic ids identical to Node.

## 4. MCP tool surface (match cbm + keep OAF brain)
memory.recall (current-truth + delta), memory.remember/approve/review, context.profile,
context.pack, architecture.overview, graph.path, graph.explain, graph.query (Cypher,
temporal), search (BM25+semantic), trace.path, detect.changes (impact), loop.verify,
manage.decision (governed ADR). Every tool read-only unless it routes through the
proposal gate.

## 5. Milestones (each a verifiable Codex slice, Node = oracle)
- M0 ✅ recall spike (parity + 9x speed/RAM).
- M1 governance core: store + write path (remember/batch/approve/supersession/dedup) +
  recall; byte-parity with Node on notes-api supersession + OAF self-ingest.
- M2 MCP server parity: full stdio tool set; single binary.
- M3 tree-sitter ingestion (start JS/TS, Python, Rust, Go) → governed structural facts;
  camel-split FTS (with the §2.6 improvements). Beats Node ingest (no entity dup, real AST).
- M4 retrieval: graph path/neighborhood + temporal Cypher; opt-in semantic search
  (precomputed embeddings + blended signals, §1.2 weights as the starting point).
- M5 intelligence: context delta + loop governance (ported, conformant) + architecture
  overview + call graph/impact.
- M6 distribution: single static binary, install + multi-agent auto-config, graph UI.
- M7 scale + polish: Linux-kernel-class index benchmark; team-shared `graph.zst`; honest
  arXiv-style eval (real repos, answer quality, tool calls) — never a cherry-picked number.

## 6. Conformance & honesty discipline
- Node OAF + its tests + the real-repo scenarios (notes-api supersession; OAF self-ingest)
  are the oracle: every overlapping Rust output must be byte-identical (minus
  timestamps/fingerprints).
- Every milestone verified on a REAL repo with REAL numbers. No clean-fixture-only tests.
  No strawman baselines. If a number is cherry-picked, label it; report the measured one.
- cbm is MIT: adopt IDEAS re-implemented on OAF's governed model (clean-room), attribute
  in THIRD_PARTY. Do not copy its C.

## 8. External strategic review (2026-06-30) — validated positioning + selective additions

An external AI review of OAF + cbm confirmed our direction; no pivot. Captured here so the
good ideas aren't lost, prioritized so they don't derail the verified slice-by-slice work.

POSITIONING (confirmed, already ours): OAF is the governed reliability/control layer; cbm is
ONE context-source organ (code/graph evidence for the Context Compiler + impact), not the
product. Matches ADR-0012. Already implemented: model-output-is-never-authority (proposal
gate), append-only memory history (bi-temporal supersession), local-first/no-silent-cloud.

ADOPT THE HONEST FRAMING (free, do in docs/README): "OAF makes model-mediated workflows
deterministic at the CONTROL layer (request construction, policy, state transitions, cache/
replay, side-effect handling) — NOT by pretending model sampling is deterministic." Same
anti-overclaim discipline we've used all along.

ROADMAP ADDITIONS (validated, build as future slices — NOT now; each its own verified goal):
- **Omission manifest** (high value): context packs record what was LEFT OUT + why +
  `recoverable_by`, not just what was included. Makes silent agent failures debuggable.
- **Taint / trust labels** (injection defense): tag external content (files, tool output,
  web, MCP output) with trust level controlling whether it may propose vs commit memory or
  request tools. We only have the sanitizer today.
- **Formal policy receipts** for tool calls (matched_rule, side-effect class, approval) — we
  have the pieces (MCP grants + side-effect class); formalize.

BIG BET — DEFERRED pending a deliberate decision (do NOT auto-adopt): Flight Recorder +
tamper-evident append-only event log + forensic-by-default replay modes. Powerful and
differentiating, but a large new subsystem, unproven for us, orthogonal to the value we've
verified (memory/context-delta/loop/engine). Decide explicitly before investing.

DISCIPLINE: the review is a strong strategic input, NOT gospel (it verified nothing on a real
repo, unlike our milestones). Mine it for ideas; keep shipping small verified slices; keep the
proven core central. Immediate next work is unchanged: M9 (more languages).

## 7. Lessons from cbm's issues/PRs — pitfalls to pre-empt (studied 2026-06-29)

Their tracker (120 open / 226 closed issues, 118 merged PRs) is a map of where a code-
memory engine breaks. The dominant failure classes — and how our design pre-empts them.

### 7.1 Memory safety = their #1 pain; Rust deletes it for free
cbm's `stability/performance` label is dominated by SIGSEGV / SIGBUS / use-after-free /
OOB read / buffer overflow / memory corruption→DB corruption (#390 alone aggregates 14
crash issues; also #344/#340/#336/#312/#245/#215/#189/#187/#125/#235...). **Safe Rust
eliminates this entire class.** This is the single biggest validation of the Rust choice.
Rule: stay in safe Rust; any `unsafe` block needs a justification + test.

### 7.2 What Rust does NOT fix for free — design these in
- **OOM / unbounded growth** (#581 50GB leak over days, #580 --max-memory request, #410
  big C++ never finishes, #471/#130/#106 O(n²) AST loops, #199 silent drop >512, #49 OOM
  kills the agent session, #70 fd exhaustion, #363 ignores cgroup limits). → bounded
  streaming buffers, a hard `--max-memory` cap, respect cgroup/container limits, NO O(n²)
  passes (assert complexity in tests on a large fixture), cap fd usage.
- **Concurrency/locking** (#52 SIGKILL on lock contention, #116 busy_timeout-after-WAL
  window, #277 WAL checkpoint blocked, #314 SIGBUS on shared cache dir, #50 multiple
  instances, #334 corruption on rapid kill/restart). → single-writer model, set
  busy_timeout BEFORE WAL, per-process cache isolation, crash-safe (atomic) writes.

### 7.3 Never lose or silently corrupt user data (OAF invariant — validated)
#557 (silently deletes project DB on "corrupt" detection — data loss), #367 (deletes DB on
SMB path), #334 (corruption on kill/restart), #260/#333/#391/#411 (reports success but DB
empty / only 500 nodes / drops subtrees). → OAF's never-hard-delete already wins here.
Add: integrity check after every ingest (node/fact count sanity vs input); NEVER report
"indexed/ok" on a partial or empty result — surface the shortfall with a reason (OAF's
skipped[] discipline). Corruption is recoverable, never auto-deleted.

### 7.4 Scope & security (bind to M3/M6)
#331 indexed C:/Users/{USER} instead of the repo (scope escape); #489 ignored
.git/info/exclude → OOM. #384 predictable /tmp name (symlink attack). #388 mutated agent
configs/hooks with no receipt. #453 UI made runtime CDN calls (breaks offline). #247 CI
shell injection. → never read outside the repo root; honor .gitignore AND
.git/info/exclude; safe temp files (O_EXCL, random); install shows a receipt and routes
through the proposal gate (no silent config writes); UI is 100% offline (no CDN); harden CI.

### 7.5 Extraction quality is full of edge cases (bind to M3)
Recurring: CALLS edges attributed to Module not Function (#438/#220), qualified cross-file
calls collapse (#478), duplicate symbols split callers (#546), tsconfig path aliases →
zero edges (#308), monorepo/workspace edges → zero (#408/#271), import specifiers resolved
by name only (#180), large files → zero nodes (#213), markdown/frontmatter body not
searchable (#518/#519). → don't over-promise 158 languages; do a FEW well with conformance
tests; index doc/fact text for BM25 (our camel tokenizer); attach confidence + provenance
so low-confidence extractions are flagged, not silently wrong; integrity-check node counts.

### 7.6 A hand-rolled Cypher is a bug farm (bind to M4)
9+ Cypher issues: count(*), DISTINCT, labels(), AS, LIMIT, toInteger(), WITH, label
alternation, WHERE n:Label, DISTINCT/ORDER BY/LIMIT execution order, and silent blank on
unsupported syntax (#373). → start with a SMALL, fully-specified subset, a real grammar,
a conformance test per feature, and ERROR clearly on unsupported syntax — never silently
return a wrong/blank result.

### 7.7 Distribution (bind to M6)
Single static binary triggers Windows Defender ML false positives (dedicated label). →
code-sign + notarize, reproducible builds, publish checksums + VirusTotal, install receipt.
