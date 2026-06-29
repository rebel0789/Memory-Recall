# Codex SUPER-GOAL — OAF native code intelligence (CI-1 → CI-5)

Date: 2026-06-30. Owner: rebel. Runtime: LONG autonomous (overnight, many hours).
Authoritative design: `docs/product/oaf-rust-supertool-spec.md`. Predecessor: the inspectable
super-milestone (branch `codex/rust-super-inspectable`). The verified Node OAF is the oracle.

## 0. Mission
Make OAF's NATIVE code intelligence best-in-class — close the gap to codebase-memory-mcp (cbm)
with our own Rust, all GOVERNED (every extracted fact still goes through the proposal gate and
carries provenance + trust labels — better than cbm because ours is auditable). NO external
organ dependency. Five sequenced milestones, each its own gated, checkpoint-committed slice,
honest-stop discipline.

## HOW TO COOK (read first — this is how you know the techniques)
cbm is MIT open source. For each milestone: `git clone --depth 1
https://github.com/DeusData/codebase-memory-mcp` into a temp dir, STUDY the exact files named
in that milestone to learn the technique, then REIMPLEMENT it clean-room in Rust on OAF's
governed model. Do NOT copy cbm's C; reimplement the algorithm. Attribute cbm (MIT) in
THIRD_PARTY. Each milestone below already contains the extracted technique so you are
implementing a SPECIFIED method, not guessing — the cbm files are for depth.

## GLOBAL RULES
- Base off `codex/rust-super-inspectable`. New worktree `codex/rust-super-code-intel`. Re-run
  ALL existing harnesses; M1-M9 + inspectable layer must pass before CI-1.
- Build isolation: all new code under `/rust` (+ new harness scripts only). No Node product
  files. `npm run ci` (435) green at every checkpoint. Own CI job.
- Governed: every new extracted fact/edge goes through the proposal gate, carries provenance +
  trust_level. Local-first, no network at runtime, no model. No `unsafe` without justification+test.
- Conformance: existing surfaces keep byte-parity on pre-existing fields; new surfaces verified
  by QUALITY on real repos. NEVER weaken an assertion.
- CHECKPOINT + HONEST-STOP: commit per green build+test+gate; do each milestone WELL; STOP at
  the first you cannot do well and report exactly why (like M9 stopped at Ruby). Partial is fine.
- DON'T OVERCOOK: the minimum that delivers the value; no gold-plating.

---

## CI-1 — Native semantic search via RANDOM INDEXING (model-free) — FULL GUIDE
Study cbm: `src/semantic/semantic.h` + `semantic.c`, `src/semantic/ast_profile.c`,
`src/simhash/minhash.c`, `src/pipeline/pass_semantic*.c`.
KEY CORRECTION: our M8 used a tiny static pretrained table — wrong. cbm's real engine is
RANDOM INDEXING built from the codebase's OWN co-occurrence (no external model, offline by
construction). Reimplement THAT. Opt-in (`--semantic`), default OFF with zero behavior/RAM change.

Technique (reimplement in Rust):
1. Tokenize each fact's text/metadata (subject, predicate, object, file path, signature) →
   tokens: split camelCase / snake_case / dot.separated / `:`-namespaced, lowercase; cap ~512.
2. Corpus: count document frequency per token → IDF.
3. Each token → deterministic SPARSE random vector: seed = a stable hash(token); set 8 random
   positions in a D-dim vector (D=256 is enough; 768 optional) to ±1. (Random Indexing.)
4. CO-OCCURRENCE ENRICHMENT (the semantic part): slide a window (±5 tokens) over each fact's
   token stream; blend co-occurring tokens' random vectors into each token's enriched vector;
   subsample tokens occurring >512 times (stride-sample, preserves direction); L2-normalize.
   This bridges synonyms learned from the corpus — no model needed.
5. Per-fact dense vector = IDF/TF-IDF-weighted sum of its enriched token vectors. Optionally also
   build api-signature and type-signature vectors (RI over callee names / param-return type tokens).
6. Combined score between two facts = weighted blend (weights sum ~1.0; tune, start with cbm's):
   tfidf_cosine 0.20, ri_cosine 0.25, minhash_jaccard 0.10, api 0.15, type 0.10, decorator 0.05,
   ast_struct_profile 0.10, dataflow 0.05; × a module-proximity multiplier (same dir boost ≤0.10).
7. (Optional, if time) graph diffusion: blend each fact's combined vector with the mean of its
   top-k graph neighbors (α=0.3) — transitive semantic closure.
8. QUERY-TIME semantic search: tokenize the query, build its RI vector from the SAME corpus,
   cosine vs fact vectors → ranked; BLEND with the existing BM25 keyword score + governance boost
   (current-truth + decisions ranked higher). Hybrid = the product.
GATE (`scripts/rust-semantic-ri-quality.mjs`) — RELEVANCE-GRADED (fix M8's flaw): paraphrase
queries on a real repo where query vocab DIFFERS from fact text, with MULTI-symbol relevance keys
(accept any of the genuinely-relevant facts, not one exact symbol) graded by MRR/hit-rate. ASSERT
hybrid BEATS keyword AND surfaces ≥1 relevant fact keyword misses. Default-off proven byte-identical.
If hybrid still does not beat keyword, report honestly and mark experimental — but the RI approach
should work where the static table didn't. Commit: `feat: native random-indexing semantic search`.

## CI-2 — Type-aware call resolution (call-graph accuracy)
Study cbm: `src/pipeline/lsp_resolve.h`, `src/pipeline/pass_lsp_cross.c/.h`, `src/pipeline/pass_calls.c`.
Technique: a per-file type-inference pass resolves method/qualified calls by inferring the
receiver's type (from local var declarations, params, returns, fields) → the actual
Class.method → emit a ResolvedCall {caller_qn, callee_qn, confidence, strategy}. The CALLS edge
builder uses the resolved override when caller_qn matches the enclosing function AND the BARE
last segment of callee matches (split on `.` / `::` / `->`, last wins) at confidence ≥ 0.6;
otherwise fall back to today's name-based resolution. This fixes receiver-qualified calls
(`c.inc()`, `obj.method()`, `Math::square`, `p->run`) attributing to the right method.
SCOPE: do ONE language first (Python OR TypeScript — pick the one you can do WELL with local
type inference for method calls), STOP and report rather than half-doing several. OUT: full
9-language LSP parity (too big).
GATE (`scripts/rust-typed-calls-quality.mjs`): a fixture with two classes having same-named
methods + receiver-qualified calls; assert each call resolves to the CORRECT class's method
(not the module, not the wrong same-named method); precision/recall vs a known key; no regression
of M3/M9 call-graph numbers. Commit: `feat: type-aware call resolution (lang N)`.

## CI-3 — Route detection + breadth
Study cbm: `src/pipeline/pass_route_nodes.c`, `src/pipeline/pass_pkgmap.c`, `src/discover/language.c`.
Technique: detect HTTP routes from framework patterns (decorators/annotations/registration calls
— Flask `@app.route`, Express `app.get`, Spring `@GetMapping`, etc.) → governed Route facts/edges
{method, path, handler}; match call-sites to routes by path. ALSO: **import/package resolution**
(study `pass_pkgmap.c`) — resolve `import X` / `use X` / `require(...)` to the ACTUAL in-project
target by scanning manifests (package.json, go.mod, Cargo.toml, pyproject.toml, pom.xml, …) so
IMPORTS edges point to real definitions instead of bare names (cbm bugs #180/#308/#408 were all
unresolved imports — pre-empt them). Plus add more tree-sitter languages (incremental grammars)
toward parity — each WELL with a per-language fixture (CI-2/M9 quality bar: CALLS→Function, no
truncation, dedup). OUT: gRPC/GraphQL/tRPC/IaC (defer unless time).
GATE: a fixture web app with known routes → assert Route facts + handler links; per-added-language
fixture passes. Commit per language/feature so a shaky one drops cleanly.

## CI-4 — Parallel/perf: close the ingest gap
Study cbm: `src/pipeline/pass_parallel.c` (RAM-first parallel passes, bounded workers).
Reality (from M7): our 14.5× gap is the GOVERNED WRITE PATH (proposal commit + integrity), not
parsing. Technique: keep single-writer correctness but batch-commit proposals (one transaction
per N facts), parallelize parse+extract (M7 already did some), and stream so RAM stays bounded.
Preserve DETERMINISM (parallel graph == sequential, the M7 invariant) and all governance.
GATE (`scripts/rust-ingest-perf.mjs`): ingest the OAF repo; report wall-time + RSS vs M7
(5.4s/~100MB) and per-file ms vs cbm's ~2.4ms; assert parallel output == sequential (byte-identical
fact/entity/edge sets) and M3/M9 quality numbers UNCHANGED. Honest: report the remaining gap.
Commit: `feat: batched parallel governed ingest`.

## CI-5 — Cross-repo intelligence
Study cbm: `src/pipeline/pass_cross_repo.c/.h`.
Technique: when ≥2 repos are ingested into one store, link entities across them with CROSS_*
edges (e.g. a caller in repo A → a definition/route in repo B by qualified name / package
resolution), governed + provenance-tagged. A cross-repo architecture summary over the fleet.
GATE (`scripts/rust-cross-repo-quality.mjs`): ingest two small repos where A calls into B; assert
the CROSS_* edge is created with correct attribution + provenance; single-repo behavior unchanged.
Commit: `feat: cross-repo governed edges`.

## CI-6 — Incremental git-aware indexing (the "best indexing for our project" win)
Study cbm: `file_hashes` table + git change detection + the `.codebase-memory/graph.db.zst`
shared-snapshot idea (README "Team-Shared Graph Artifact").
Technique: a `file_hashes` table (path → content hash + last-indexed time). On `oaf ingest`,
diff the working tree (git status / hash compare) against stored hashes; re-parse ONLY changed/
added files; for a changed file, SUPERSEDE its old facts/entities/edges (governed — never hard-
delete, full provenance) and emit the new ones; drop facts for deleted files (supersede→inactive).
Unchanged files are skipped entirely. Add `oaf ingest --incremental` (and make it the default when
a prior index exists). Optional: a `.oaf/graph.zst` compressed governed-graph snapshot (zstd) that
a teammate imports before incremental fill-in (fast onboarding) — additive, opt-in.
GATE (`scripts/rust-incremental-quality.mjs`): ingest a repo; modify ONE file + add ONE + delete
ONE; re-ingest --incremental; assert only those 3 files were re-parsed (others skipped), the
changed file's old facts are superseded (not duplicated, history intact), the deleted file's facts
go inactive, and the resulting graph == a full re-ingest (correctness preserved). Report the
incremental time vs full (should be a large speedup on a small change). Commit: `feat: incremental
git-aware governed indexing`.

## CI-7 — Near-clone (SIMILAR_TO) + dead-code (cheap, reuses earlier work)
Study cbm: `src/simhash/minhash.c` (MinHash/LSH), the dead-code tool semantics.
Technique: (a) SIMILAR_TO — using the MinHash fingerprints already computed in CI-1, emit
governed `SIMILAR_TO` edges between functions whose Jaccard similarity exceeds a threshold (LSH
banding to avoid O(n²)); surfaces duplicate/near-duplicate code. (b) Dead-code — a read-only query
returning functions with ZERO incoming CALLS edges, EXCLUDING entry points (main, exported, route
handlers, test fns). Both governed/provenance-tagged; dead-code is read-only.
GATE (`scripts/rust-clone-deadcode-quality.mjs`): a fixture with a known near-duplicate pair and a
known unused function; assert the SIMILAR_TO edge appears and the dead-code query returns the unused
fn but NOT the entry points. Commit: `feat: similar-to near-clone and dead-code detection`.

## DEFERRED goodies (do NOT build — out of scope, noted for later)
gRPC/GraphQL/tRPC routes, IaC/K8s/Terraform resource indexing, DATA_FLOWS (arg→param) edges,
pub/sub channel detection (EMITS/LISTENS_ON), the 3D galaxy UI. Niche for OAF or large scope —
revisit only if explicitly prioritized.

---

## Definition of done (per milestone + overall)
- [ ] Based on super-inspectable; M1-M9 + inspectable still pass before CI-1 and after EACH milestone.
- [ ] Each completed milestone: its gate passes; existing surfaces byte-parity on pre-existing
      fields; new surfaces quality-verified on a real repo; THIRD_PARTY attributes cbm; checkpoint
      committed.
- [ ] Node `npm run ci` green (435) at every checkpoint; only `/rust` + new harness scripts touched.
- [ ] Honest report per milestone (numbers + unhandled) and explicit note if a milestone was
      STOPPED (and why) rather than degraded.

## Reporting
End with: per-milestone status (done / stopped-with-reason), each gate's numbers (esp. CI-1
relevance-graded keyword-vs-hybrid, CI-2 typed-call precision/recall, CI-4 speedup + remaining
gap), the THIRD_PARTY attribution, final harness/CI state, and an explicit "stopped / unhandled /
open questions" list. Real numbers only.
