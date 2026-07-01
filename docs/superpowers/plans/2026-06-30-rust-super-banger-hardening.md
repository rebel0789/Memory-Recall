# Codex SUPER-GOAL — OAF "Banger": all-languages + harden + real-repo benchmarks + bug-hunt

Date: 2026-06-30. Owner: rebel. Runtime: VERY LONG autonomous (target 6-20h, far beyond the
prior ~2h goals). Authoritative design: `docs/product/oaf-rust-supertool-spec.md`. Predecessor:
the universal-ingestion campaign (branch `codex/rust-super-ingestion`). Verified Node OAF is the
oracle. You (Codex) are given REASONING LATITUDE within each phase — prioritize, evaluate, design
benchmarks, and find/fix bugs using your own judgement — but the HARD RULES below are
non-negotiable.

## 0. Mission
Take OAF from "feature-complete and verified" to "hardened, broad, and proven on real repos."
One consolidated branch with everything. Add as many languages as you can do WELL. Fine-tune the
known gaps. Then PROVE it on real-world repositories with honest benchmarks, real use cases, and
an aggressive bug-hunt — fixing what you find. Work in phases, step by step. Stop a phase only when
done well or genuinely blocked (report why).

## HARD RULES (non-negotiable — apply to every phase, no latitude here)
1. Base off `codex/rust-super-ingestion`. New worktree `codex/rust-super-banger`. Re-run ALL
   existing harnesses; M1-M9 + inspectable + CI-1..CI-7 + UI-1..UI-4 must pass before Phase A, and
   AFTER every checkpoint (no regression — if any prior gate breaks, fix before continuing).
2. Build isolation: `/rust` + new harness/bench scripts + the oaf-memory skill doc only. NO other
   Node product files. `npm run ci` (435) green at every checkpoint. Own CI job.
3. Governed + local-first at RUNTIME: every fact through the proposal gate, provenance + trust,
   never hard-delete. No model, no network, no cloud, no external DB AT RUNTIME. (External
   build-time crates — tree-sitter grammars, PDF/parse libs — are FINE and encouraged; vendor/pin
   them. Cloning real repos for the benchmark phase is a TEST-time action, fine.)
4. NEVER weaken or delete an assertion to make it pass. NEVER game a benchmark (realistic
   baselines, real inputs, report failures, label methodology). If something can't be done well,
   STOP that item and report honestly — partial is fine, broken/faked is not.
5. No `unsafe` without a justification comment + a test. Commit per green `cargo build && cargo
   test && node scripts/<gates>` — many small checkpoint commits, conventional messages.

## Phase A — ALL the languages (breadth)
Goal: extend governed tree-sitter ingest far beyond the current ~11. Add as many languages as you
can do WELL — aim for a large breadth (target 25-40 common languages: Ruby, PHP, C#, Swift, Kotlin,
Scala, Lua, R, Bash/Shell, Haskell, Elixir, Dart, Zig, OCaml, Perl, Julia, Clojure, Erlang, Groovy,
SQL, HTML/CSS, YAML/TOML, Objective-C, etc.). For EACH: vendored grammar; extract File/Module/
Function/Class/Method + DEFINES/IMPORTS/CALLS (CALLS→Function/Method NEVER Module — cbm #220/#438);
a per-language conformance fixture with a known call graph asserting precision/recall + dedup + no
silent truncation. Use your judgement to order by real-world usage and to STOP at any language you
can't do well (report it, don't degrade). Report the binary-size growth.
GATE: each added language has a passing fixture; the existing multi-language real-repo check still
passes; report a per-language precision/recall table + the final language count.

## Phase B — Fine-tune / harden known gaps (use your judgement on priority)
Address the real, known weaknesses — pick the order, do what you can do well:
- Make incremental indexing (UI/CI-6) the DEFAULT when a prior index exists (it was opt-in);
  prove the default path still equals a full re-ingest.
- Extend type-aware call resolution (CI-2) beyond the single language to 2-3 more where you can do
  it well.
- Narrow the governed-ingest speed gap (~15x vs cbm): batched proposal commits, bounded parallel
  parse + single-writer, mmap pragmas — WITHOUT losing determinism or governance. Report the new
  per-file ms + remaining gap honestly.
- Deepen semantic (CI-1): add the remaining signals from the cbm blend you don't yet have
  (API-signature, type-signature, AST-profile, dataflow) and re-run the graded eval — keep it
  honest (multi-symbol keys; report if it doesn't improve).
- Any other quality gap you find while working — fix it with a regression test.
GATE: each change has a test; no regression; honest before/after numbers for speed + semantic.

## Phase C — REAL-WORLD benchmarks + use-cases + BUG-HUNT (the most important phase)
This is where we learn the truth. Clone a SET of diverse real public repos (test-time, read-only)
spanning languages + sizes — e.g. a Python web app, a Go service, a Rust CLI, a TS frontend, a
large-ish monorepo, plus 2-3 others of your choosing. Add `scripts/rust-realworld-bench.mjs`.
For each repo, MEASURE and report HONESTLY (no strawman, label methodology):
- ingest time + peak RAM + fact/entity/edge counts; per-file ms;
- recall quality on realistic structural questions (graded);
- token + tool-call reduction vs a realistic multi-call file-by-file baseline (the honest CI/M7
  methodology — NOT single-call, NOT whole-repo dump);
- semantic hybrid-vs-keyword (graded, multi-symbol keys);
- a real AGENT-SESSION use case end-to-end (ingest → context pack with omissions → recall with
  provenance/trust → loop verify catching a governed-decision violation) and a CONVERSATIONAL
  use case (consolidate a transcript: ADD/UPDATE/DELETE/NOOP) and the WIKI.
BUG-HUNT (use high reasoning): aggressively stress edge cases — very large files, unusual
encodings, deeply nested ASTs, conflicting/duplicate facts, rapid incremental edits, malformed
inputs, concurrent access — and look for crashes, incorrect extraction, perf cliffs, silent
truncation, memory growth, governance violations. For EACH bug found: record it, FIX it (governed,
minimal), and add a regression test. Report ALL bugs found + fixed + any you could not fix (honest).
GATE: `rust-realworld-bench.mjs` runs on ≥5 real repos and emits a report with the real numbers +
a bug ledger (found/fixed/open) + the use-case results. Numbers must be honest and reproducible.

## Phase D — Release polish (your discretion on depth)
- Confirm the single release binary + `oaf install` (receipt-first) + `oaf ui` work end-to-end.
- Write/refresh a real README + quickstart so a new user can install OAF and ingest a repo in
  minutes (positioning per spec §8: governed local control plane; cbm/others are organs).
- Note packaging/signing as deferred (don't build the signing pipeline).
GATE: a fresh-clone smoke test (build → ingest a sample → recall → ui) documented and passing.

## Definition of done (overall)
- [ ] One branch (codex/rust-super-banger) with ALL prior work + the new phases.
- [ ] M1-M9 + inspectable + CI-1..CI-7 + UI-1..UI-4 all still pass; Node ci green (435); cargo green.
- [ ] Phase A: a per-language precision/recall table + final language count.
- [ ] Phase B: honest before/after for speed + semantic + incremental-default proof.
- [ ] Phase C: the real-world bench report (≥5 repos, honest numbers + methodology), the use-case
      results, and the BUG LEDGER (found/fixed/open).
- [ ] Phase D: the README/quickstart + a passing fresh-clone smoke test.
- [ ] Honest final report with everything stopped/unhandled/open.

## Reporting (this is what I will verify at the end — make it complete and honest)
End with: phase-by-phase status; the per-language table; the speed/semantic before-after; the
real-world bench numbers per repo (with methodology); the bug ledger; the use-case outcomes; the
final harness/CI state; and an explicit "stopped / unhandled / open questions" list. Real numbers
only — if a benchmark looks too good, scrutinize and explain it; if something is broken, say so.
