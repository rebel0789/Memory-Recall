# Codex goal — OAF Rust supertool, M8: opt-in local semantic search

Date: 2026-06-29. Owner: rebel. Runtime: long autonomous run. Authoritative design:
`docs/product/oaf-rust-supertool-spec.md`. Predecessor: the honest-eval tip
(branch `codex/eval-honest-fix`). Build M8 ONLY.

## 0. Mission
Add OPT-IN local semantic search over the governed graph — meaning-based retrieval that
finds facts whose wording differs from the query — with NO live model and NO network at
query time. It MUST be proven to beat keyword search on paraphrase queries or it ships as
experimental, not a claimed win. Disabled by default so OAF's no-model purity is preserved.

## STEP 0 — base correctly
Branch off `codex/eval-honest-fix`. New worktree `codex/rust-core-m8-semantic`. Re-run all
existing harnesses (recall/ingest/graph/intelligence/distribution/eval); M1-M7 + honest eval
must still pass before adding M8.

## 1. Sourcing decision (RESOLVED — do not re-litigate)
The embedding table is the INPUT token-embedding layer extracted from a Nomic Apache-2.0
embedding model (prefer the code variant, e.g. nomic-embed-code, for code semantics;
nomic-embed-text is acceptable fallback). Apache-2.0 permits this with attribution.
- Offline generator script (`scripts/build-embedding-table.*` or a small Rust xtask): load
  the model's input embeddings, keep a vocabulary of code-relevant tokens, quantize to int8,
  write OAF's compact `token -> int8[d]` table format. Record source model + license +
  checksum in `THIRD_PARTY`.
- The table is NOT a live model — only a static lookup. If it is >~10MB, DO NOT commit it:
  gitignore it, ship the generator + a documented build/download step, and have the binary
  load it from a known path only when semantic is enabled. Document the size.

## 2. Rust semantic search (opt-in, no live inference)
- Enabled only via `--semantic` (CLI) / a config flag / an MCP arg; DEFAULT OFF. When off:
  no table load, zero added RAM, recall/search behavior byte-identical to today (assert it).
- At index/approve time (only when enabled): compute each fact's vector = mean-pool of its
  token vectors (tokens via the M3 camel+ tokenizer: split camelCase/snake/digit/colon),
  store int8 vectors in an `embeddings` table.
- At query time: tokenize + pool the query the same way; rank by a HYBRID score = blend of
  cosine(query, fact) + the existing BM25 keyword score + a governance boost (current-truth
  and `decision`/`adr` facts ranked higher). No neural inference — pure table lookup + cosine.
- Local only; the table is bundled/pre-generated; no network at query time.

## 3. THE GATE — honest paraphrase benchmark (this decides if it ships as a win)
Add `scripts/rust-semantic-quality.mjs`. On a real repo, a query set where the query VOCAB
DIFFERS from the fact text, each with a known-relevant fact key, e.g.:
  - "database backend" -> should surface the sqlite memory provider / MemoryBackendPort facts
  - "how are auth tokens issued" -> issueToken / token_expiry facts
  - "what governs the UI" -> the offline-UI decision fact
Measure hit-rate (or MRR@k) for: (a) keyword-only, (b) semantic-only, (c) hybrid. ASSERT
hybrid >= keyword on this paraphrase set AND that hybrid surfaces >=1 relevant fact that
keyword MISSES. If hybrid does NOT beat keyword, DO NOT claim a win — report the honest
numbers and mark semantic search EXPERIMENTAL/opt-in-unproven. No strawman; report failures.

## 4. Carry invariants + memory
Default-off = zero behavior/RAM change (assert). When on: table loaded lazily/mmap, bounded
RAM, no O(n^2). Governed/proposal-gated/current-truth unchanged. No `unsafe` without
justification + test.

## 5. Benchmark
Semantic index build time + table size + per-query latency + RSS (enabled vs disabled).
Report a table.

## 6. Checkpoint & stop
Commit per green `cargo build && cargo test && node scripts/<harnesses>`. Stop at the first
blocker (e.g. model-extraction issue) and report honestly. Stay in scope (semantic only;
NOT more languages — that is the next goal). Node `npm run ci` green; only /rust + new
harness/generator touched.

## 7. Definition of done
- [ ] Step 0: based on eval-honest-fix; M1-M7 + eval still pass.
- [ ] Embedding table generated from an Apache-2.0 Nomic model, int8, attributed in THIRD_PARTY,
      size documented, not committed if large.
- [ ] Opt-in semantic/hybrid search; DEFAULT OFF with zero behavior/RAM change proven.
- [ ] Paraphrase benchmark reported (keyword vs semantic vs hybrid, MRR/hit-rate); hybrid
      either BEATS keyword (claim the win) or is honestly marked experimental.
- [ ] Benchmark table (build/size/latency/RSS); Node ci green (435); only allowed files touched.
- [ ] Honest report incl. whether semantic actually beat keyword and by how much.

## 8. Reporting
End with: the paraphrase benchmark table (keyword/semantic/hybrid + which relevant facts
keyword missed), the build/size/latency/RSS table, the THIRD_PARTY attribution, the DoD
checklist, and an explicit honest verdict (proven win vs experimental). Real numbers only.
