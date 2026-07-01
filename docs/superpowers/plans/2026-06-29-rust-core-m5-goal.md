# Codex goal — OAF Rust supertool, Milestone M5: intelligence layer

Date: 2026-06-29. Owner: rebel. Runtime: long autonomous run (overnight ok).
Authoritative design: `docs/product/oaf-rust-supertool-spec.md`. Predecessor: M4 (branch
`codex/rust-core-m4`). Build M5 ONLY.

## 0. Mission
Add OAF's intelligence/reliability layer and close the two M2 debts: complete context.pack
and compressed context.profile (byte-parity with Node), port the full context delta
delivery and loop governance (byte-parity with Node), and add impact/detect-changes (git
diff → affected symbols via the M3 call graph; quality-verified). No model, no network.

## STEP 0 — base correctly
Branch off `codex/rust-core-m4`. New worktree `codex/rust-core-m5`. Re-run the existing
parity + ingest-quality + graph-query harnesses; M1-M4 must still pass before adding M5.

## 1. Repo & build isolation (unchanged)
All code under `/rust`. Do NOT modify Node files except the existing harnesses. Node
`npm run ci` (435) stays green. Own CI job. No network/model. Remember `cargo clean` or rely
on the `/rust/target` gitignore so repo checks don't trip on build artifacts.

## 2. Scope — IN vs OUT
IN:
- context.pack (CLOSE the M2 deferral) — byte-parity with Node MCP/CLI context.pack.
- compressed context.profile (CLOSE the M2 caveat) — byte-parity with Node (both the
  currentTruthOnly and the compressed/default paths).
- context delta delivery end-to-end (profile + pack + recall deltas) — byte-parity, the
  session token-saver.
- loop governance: `loop verify` with `governanceAssertions` checked against active
  governed memory (the moat feature) — byte-parity with Node loop verify, including the
  governance-violation block + stopReason.
- impact / detect.changes: given a git diff (changed files/lines), map to affected
  symbols/facts via the M3 call graph, with risk/why — NEW, quality-verified.
All exposed via CLI + MCP where Node exposes them. Read-only except loop verify's governed
checks which stay within the proposal model.
OUT (scope violation if built): semantic/vector search, UI, install/distribution, more
ingestion languages, cross-repo, parallel-ingest optimization (that's M7).

## 3. Verification — modes per surface
- context.pack / compressed context.profile / context delta / loop verify: BYTE-PARITY
  with Node (Node has these). Drive the SAME inputs through Node and Rust on the real
  scenarios (notes-api governed memory; the loop-governance scenario: governed
  token_expiry=15, a worktree reverting it to 60 must BLOCK with governance-violation even
  when the validation command passes). Extend the harnesses. NEVER weaken an assertion.
- impact / detect.changes: QUALITY on a real diff (Node has no equivalent oracle). On a
  known change to a fixture/OAF file, assert the affected-symbol set is correct (the
  callers of a changed function, via the call graph), no false "module-level" attribution,
  and an honest "unresolved" list for dynamic/alias cases.
- Temporal/governance: the loop-verify governance scenario must match Node byte-for-byte;
  the context delta must show correct retraction across a supersession.

## 4. Carry invariants (M1-M4)
Governed/proposal-gated; never hard-delete; current-truth filtering; bounded results
(truncation flagged, never silent); no O(n²); single-writer/atomic; local-first, no
network/model.

## 5. Benchmark
context.pack, context delta (full vs delta session), loop verify, detect.changes latency +
RSS vs Node. Report a table + the session token-saving % on a real multi-turn scenario
(measured honestly, same content both ways — no strawman baseline).

## 6. Checkpoint protocol & stop conditions
Commit per green `cargo build && cargo test && node scripts/<harnesses>`. Stop at the first
blocker you can't resolve without guessing Node's behavior; report it. No `unsafe` without
justification + test. Stay in scope.

## 7. Definition of done
- [ ] Step 0: based on rust-core-m4; M1-M4 still pass.
- [ ] context.pack + compressed context.profile byte-parity (M2 debts CLOSED).
- [ ] context delta delivery byte-parity (with correct retraction across supersession).
- [ ] loop verify governance byte-parity (blocks a governed-decision violation when tests
      pass; matches Node's report).
- [ ] impact/detect.changes quality-verified (correct affected-symbol set, honest unresolved
      list).
- [ ] All exposed via CLI + MCP; benchmark table + honest session token-saving %.
- [ ] Node `npm run ci` green (435); Node untouched except harnesses.
- [ ] Honest report: parity per surface, impact quality numbers, bench, open questions.

## 8. Reporting
End with: the byte-parity table (pack/profile/delta/loop), the impact quality numbers, the
session token-saving %, the benchmark table, the DoD checklist, and an explicit "deferred /
unresolved / open questions" list. Real numbers only.
