# Codex goal — OAF Rust supertool, Milestone M1: governance core

Date: 2026-06-29. Owner: rebel. Runtime: long autonomous run (overnight ok).
Authoritative design: `docs/product/oaf-rust-supertool-spec.md` — READ IT FIRST, in full.
The verified Node OAF is the conformance oracle. This goal builds M1 ONLY.

## 0. Mission (one paragraph)
Build the Rust governance core of Open Agent Fabric — the bi-temporal, proposal-gated
memory store + write path + recall — as a new Cargo workspace under `/rust`, producing
JSON byte-identical to the existing Node OAF on two real-repo scenarios, with native
speed/RAM, and storage hardened against the failure classes documented in spec §7. Do not
build M2+ features (MCP server breadth, tree-sitter, Cypher, semantic search) — they are
explicitly out of scope. Stop cleanly when the definition of done is met or at the first
blocker you cannot resolve without guessing.

## 1. Repository & build isolation (do not break the build)
- Work in the SAME repo. Base on branch `codex/rust-recall-spike`; new worktree
  `codex/rust-core-m1`. All new code lives under `/rust` (expand the spike crate).
- DO NOT modify: `package.json`, `apps/`, `providers/`, `tests/`, `scripts/check.mjs`, or
  any existing Node file, EXCEPT adding ONE new conformance script under `scripts/` and
  ONE new CI job file. The Node build must stay green: run `npm run ci` at the end and
  confirm 435 tests still pass, untouched.
- `/rust` is a self-contained Cargo workspace with its own `Cargo.toml`, its own
  `cargo build`/`cargo test`, and its own CI job (add `.github/workflows/rust.yml` — Rust
  only; do not edit existing workflows).
- No network at build or runtime beyond `cargo` fetching crates at build time. No model
  calls. Pin crate versions in Cargo.lock.

## 2. Crate layout (M1 subset)
- `/rust/Cargo.toml` (workspace)
- `/rust/oaf-store` — rusqlite, schema, FTS + tokenizer, governance/temporal logic, write
  + read paths.
- `/rust/oaf` — CLI + single-binary entry exposing the M1 subcommands and the MCP
  recall path (reuse the spike's recall).
- Keep `oaf-recall` spike code or fold it into `oaf`; either way recall parity must hold.

## 3. Scope — IN (build) vs OUT (defer, do NOT touch)
IN: schema; `memory remember` (single); `memory remember --batch`; `memory approve`
(`--all`, `--all-from`); `memory reject`; `memory review`; supersession on approve; entity
dedup; `memory recall` (current-truth full + cursor delta `{c,d,r}` + retraction); the
camel+ tokenizer; storage hardening; the conformance harness + benchmark.
OUT (M2-M7 — building any of these is a scope violation): full MCP tool surface beyond
recall, `context.*`, tree-sitter ingestion, graph path/explain/Cypher, semantic search,
loop governance, architecture overview, the graph UI, install/distribution. If you think
you need one of these for M1, you are wrong — stop and note it instead.

## 4. Schema (governed/temporal superset — match Node ids exactly)
Tables (rusqlite, bundled SQLite): `facts` (id, workspace_id, scope, subject, predicate,
object, text, status, source, confidence, valid_from, valid_until, superseded_by,
episode_id, proposal_queue_id, created_at, updated_at, metadata_json), `entities`
(id, workspace_id, scope, kind, name, …; IDENTITY = (workspace_id, scope, name) — one row
per name, the dedup invariant), `edges` (id, source_entity_id, target_entity_id, predicate,
fact_id, status, valid_from, valid_until, …), `proposals` (queue), `episodes`, `facts_fts`
(FTS5 over fact text using the §6 tokenizer). Deterministic ids MUST be byte-identical to
Node's (same hash inputs — verify against Node output, do not invent a new scheme).

## 5. Write path (match Node semantics exactly — Node is the spec)
- `remember` (single): a brand-new (subject,predicate,object) auto-activates (status
  active) WITHOUT a pending gate, exactly as Node does (confirmed behavior).
- `remember --batch facts.json`: route each fact through the proposal gate (pending).
  Sanitizer: allow ordinary prose punctuation (comma, semicolon, parens) in `object` and
  `notes`; BLOCK absolute paths, file://, drive paths, newlines, and secret patterns
  (token=/secret=/password=/api_key=, sk-…, gh*_…, AKIA…). On rejection, do NOT drop
  silently — emit `skipped: [{index, subject, predicate, reason}]` in the report.
- `approve` (`--all`, `--all-from <workspace://source>`): activate pending facts; on a fact
  carrying supersedes intent, retire the prior active fact for (subject,predicate)
  (status superseded, set superseded_by), maintain edges (no phantom edges left active),
  entities deduped by name.
- `reject`, `review`: match Node.
- INVARIANTS: never hard-delete; proposal-gated; local-only.

## 6. Tokenizer (camel+, beats cbm)
FTS indexes fact text expanded so keyword recall matches identifier components. Split:
(a) lowercase→uppercase (`updateCloud`→`update cloud`), (b) uppercase-run→upper-then-lower
(`XMLParser`→`XML parser`), (c) digit boundaries (`parseV2`→`parse v2`), (d) `:` `_` `-`
namespaced/separator ids (`provider:native:memory`→`provider native memory`). Keep the
ORIGINAL token too (so exact matches still rank). Apply to fact text, not just code.

## 7. Read path
`recall` (currentTruthOnly): full current-truth list when no cursor; delta `{c, d, r}`
(c=cursor, d=changed facts with id/subject/predicate/value, r=retracted ids) when a cursor
is applied; cursor auto-persist per (tool,args) as in the Node spike. Match the spike's
JSON byte-for-byte.

## 8. Storage hardening (spec §7.2/7.3 — BAKE IN FROM COMMIT 1, not retrofit)
- Set `busy_timeout` BEFORE `journal_mode=WAL` (close the SQLITE_BUSY window, cbm #116).
- Single-writer model; serialize writes; atomic/crash-safe commits.
- Per-process cache/db isolation (no shared-handle SIGBUS, cbm #314).
- Integrity check after every write: refuse to report success on an empty/partial result;
  surface the shortfall with a reason. NEVER auto-delete or truncate user data on a
  read/parse error — surface it (cbm #557/#367/#260).
- A `--max-memory` cap is NOT required for M1 (no bulk ingest yet) but do not introduce any
  O(n²) loop or unbounded buffer in the write/recall paths.
- TEST: a test that kills the process mid-write (or simulates it) and asserts the DB
  reopens clean with zero data loss.

## 9. Conformance harness — THE GATE (must pass; do not weaken)
Add `scripts/rust-recall-conformance.mjs` style harness (extend the existing one). It runs
the SAME commands through the Node `apps/cli/oaf.mjs` and the Rust binary against the SAME
SQLite, and asserts byte-identical JSON (ignore ONLY `generatedAt` and `*fingerprint`
fields). Two REAL scenarios:
- Scenario A (notes-api supersession): record token_expiry=60 (single remember) →
  batch a map where token_expiry=15 supersedes, refresh_tokens="enabled, 24h" (comma),
  plus a fact whose object is a `/Users/...` path and one with `token=SECRETVALUE` →
  approve. Assert: recall returns "15 minutes", NO "60 minutes" leak; the comma fact
  records; the path + secret facts are in `skipped[]` WITH reasons; Node and Rust JSON
  match.
- Scenario B (OAF self-ingest shape): seed a multi-entity governed map where one entity is
  both a subject and an object; approve; assert one entity id per name (dedup),
  recall("MemoryBackendPort"-style CamelCase) > 0 via the tokenizer, and Node/Rust JSON
  match.
If any case fails, FIX the Rust side (Node is the oracle). NEVER edit the assertion to pass.

## 10. Benchmark (real numbers)
Measure Rust vs the recorded Node baseline (cold 50ms/55MB, init+recall 60ms/60MB): write
latency, approve latency, recall latency, peak RSS (`/usr/bin/time -l`). Report a table. No
cherry-picking; report what you measure.

## 11. Checkpoint protocol & stop conditions
- Commit after each green `cargo build && cargo test && node scripts/<harness>` — small,
  focused commits. Conventional commit messages.
- Stop at the FIRST blocker you can't resolve without guessing Node's behavior; write what
  you tried and what's ambiguous. Do not invent behavior that diverges from Node.
- Never weaken a conformance assertion, never `unsafe` without a justification comment + a
  test, never touch Node files outside the one harness + one CI job.

## 12. Definition of done (checklist — all must be true)
- [ ] `/rust` workspace builds (`cargo build --release`) and `cargo test` is green.
- [ ] Conformance scenarios A and B pass with byte-parity vs Node.
- [ ] Storage hardening §8 implemented + the kill-mid-write test passes.
- [ ] Benchmark table reported (Rust vs Node baseline).
- [ ] Node `npm run ci` still green (435 tests), Node files untouched except the one
      harness + one CI job.
- [ ] A short report: conformance pass/fail per scenario, bench table, and ANY Node
      behavior you could not match — surfaced honestly, never papered over.

## 13. Reporting
End with: the conformance result (A/B byte-parity), the benchmark table, the DoD checklist
state, and an explicit "could not match / open questions" list. Real numbers only. If
something is partial, say so plainly.
