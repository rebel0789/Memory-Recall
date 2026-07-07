# Codex goal — OAF Rust supertool, Milestone M7: parallel ingest + honest eval

Date: 2026-06-29. Owner: rebel. Runtime: long autonomous run (overnight ok).
Authoritative design: `docs/product/oaf-rust-supertool-spec.md` (esp. §7.2 memory pitfalls,
§6 honesty). Predecessor: M6 (branch `codex/rust-core-m6`). Build M7 ONLY. This is the last
core milestone — after it the Rust supertool is feature-complete and fast.

## 0. Mission
Close the ONE axis where we're not yet better than cbm — per-file ingest speed (M3 measured
~38ms/file vs cbm's ~2.4ms/file) — by parallelizing the tree-sitter ingest, WITHOUT losing
M3's correctness, governance, or determinism. Then produce an HONEST arXiv-style eval (real
repos, answer quality + token + tool-call reduction) — measured straight, never a
cherry-picked number.

## STEP 0 — base correctly
Branch off `codex/rust-core-m6`. New worktree `codex/rust-core-m7`. Re-run ALL existing
harnesses (recall/ingest/graph/intelligence/distribution); M1-M6 must still pass.

## 1. Repo & build isolation (unchanged)
All code under `/rust`. Do NOT modify Node files except the existing harnesses + a new eval
harness. Node `npm run ci` (435) stays green. Own CI job. No network/model at runtime.

## 2. Scope — IN vs OUT
IN:
- Parallel ingest: parallelize per-file tree-sitter parse + extraction across a bounded
  worker pool; merge into the governed store via the single-writer model (workers parse +
  extract in parallel; one writer commits). Honor `--max-memory` and a `--workers N` cap that
  respects cgroup/container limits (cbm #363).
- Honest eval harness: on real repos, measure answer-quality + token reduction + tool-call
  reduction of graph queries vs naive file-by-file exploration.
OUT (scope violation if built): semantic/vector search (separate opt-in milestone), more
ingestion languages, cross-repo, signing/packaging, the team-shared graph.zst artifact (a
later nicety — note it, don't build it).

## 3. Parallel ingest — correctness & determinism are non-negotiable
- DETERMINISM: parallel ingest MUST produce the SAME governed graph as sequential ingest —
  byte-identical fact/entity/edge ID sets and the same content. Deterministic ids; no
  race-induced ordering differences in the committed graph. Add a test asserting
  parallel-output == sequential-output on a fixture + the OAF repo.
- CORRECTNESS UNCHANGED: re-run the M3 ingest-quality harness — call-graph precision/recall,
  dedup, no silent truncation, idempotent re-ingest, supersession — must be IDENTICAL to M3.
  Parallelism may not regress any quality number.
- MEMORY SAFETY (cbm §7.2): parallel ingest is the OOM-risk hotspot (cbm #581/#49). Enforce
  the --max-memory cap across workers (bounded in-flight ASTs; release per-file AST after
  extraction); bounded worker queue; cap file descriptors (cbm #70). Add a test that ingests
  under a tight --max-memory and stays within it (no unbounded growth).
- No data races (safe Rust); no `unsafe` without justification + test.

## 4. Honest eval (cbm §6 / §7 discipline — NO strawman, NO cherry-pick)
Add `scripts/rust-eval.mjs`. On at least TWO real repos (e.g. the OAF repo + one external
real repo you fetch read-only into a temp dir), for a fixed set of realistic structural
questions, measure:
- tokens to answer via OAF graph queries vs naive file-by-file (grep/read) exploration;
- tool-call count for each;
- answer quality (did the graph answer contain the correct symbols/edges — graded
  PASS/PARTIAL/FAIL against a known key).
RULES: the file-by-file baseline must be a REALISTIC exploration, NOT whole-repo dumping;
report the MEASURED numbers honestly (expect roughly an order of magnitude, like cbm's
peer-reviewed 10x — do NOT engineer a 120x headline); label methodology; report failures.

## 5. Benchmark
Parallel ingest: wall time + peak RSS on the OAF repo vs M3's sequential (5.4s / ~100MB),
and per-file ms vs cbm's documented ~2.4ms/file. Report the speedup honestly (we likely
won't fully match a mature parallel-C engine — state the real gap that remains).

## 6. Checkpoint protocol & stop conditions
Commit per green `cargo build && cargo test && node scripts/<harnesses>`. Stop at the first
blocker; report honestly (including if parallelism can't reach a target — report the real
number, don't fake it). Stay in scope.

## 7. Definition of done
- [ ] Step 0: based on rust-core-m6; M1-M6 still pass.
- [ ] Parallel ingest: deterministic (parallel == sequential graph), M3 quality numbers
      UNCHANGED, within --max-memory, materially faster than M3 sequential.
- [ ] Honest eval on >=2 real repos: token + tool-call + answer-quality numbers reported with
      methodology; realistic baseline (no strawman); honest (no cherry-pick).
- [ ] Benchmark table incl. the remaining speed gap vs cbm stated honestly.
- [ ] Node `npm run ci` green (435); Node untouched except harnesses.
- [ ] Honest report: speedup + remaining gap, eval numbers + methodology, open items.

## 8. Reporting
End with: the parallel-ingest speedup (+ determinism + quality-unchanged proof), the honest
eval numbers (token/tool-call/answer-quality with methodology and any FAILs), the remaining
speed gap vs cbm stated plainly, the DoD checklist, and an explicit "open questions" list.
Real numbers only — if a target is missed, report the real number.
