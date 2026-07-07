# Codex SUPER-GOAL — OAF Rust supertool: the Inspectable Governed Layer

Date: 2026-06-30. Owner: rebel. Runtime: LONG autonomous run (overnight, many hours OK).
Authoritative design: `docs/product/oaf-rust-supertool-spec.md` (esp. §2 deltas, §7 lessons,
§8 review). Predecessor: M9 (branch `codex/rust-core-m9-langs`). The verified Node OAF is the
conformance oracle.

## 0. Mission (one theme — do NOT scope-creep beyond it)
Make OAF's governed context & memory the most INSPECTABLE, TRUSTWORTHY, and AUDITABLE layer
that exists — the moat no code-memory tool has. Five sequenced milestones (S1→S5), each its
own tightly-scoped, gated, checkpoint-committed slice. This is the differentiator work; it is
NOT more languages, NOT semantic search, NOT a flight recorder/replay (all explicitly deferred
— building them is a scope violation).

## GLOBAL RULES (apply to every milestone)
- Base off `codex/rust-core-m9-langs`. New worktree `codex/rust-super-inspectable`. Before S1,
  re-run ALL existing harnesses (recall/ingest/graph/intelligence/distribution/eval/semantic);
  M1-M9 must pass.
- Build isolation: all new code under `/rust` (+ new harness scripts only). Do NOT modify any
  Node product file. Node `npm run ci` (435) MUST stay green at every checkpoint. Own CI job.
- Conformance discipline: where a surface already exists in Node, EXISTING fields stay
  byte-parity (new fields are additive and excluded from the byte-parity comparison, like
  generatedAt/fingerprint). Where a surface is new, verify by QUALITY on a real repo. NEVER
  weaken an assertion to pass.
- Local-first, proposal-gated, never hard-delete, no network/model at runtime, no `unsafe`
  without justification + test. Carry all M1-M9 invariants.
- CHECKPOINT + HONEST-STOP: commit per green `cargo build && cargo test && node scripts/<gate>`.
  Do each milestone WELL; STOP at the first milestone you cannot do well and report exactly why
  (like M9 stopped at Ruby — do NOT weaken a fixture or fake a result to continue). Partial is
  fine; broken is not.
- DON'T OVERCOOK: each milestone is the minimum that delivers the value. No gold-plating, no
  speculative abstraction, no config DSLs. Small, sharp, verified.

---

## S1 — Omission manifest (context inspectability) — THE sharpest differentiator
Mission: context packs record not just what was included but what was LEFT OUT and WHY — so a
human/agent can see what the model did NOT see.
- Add an additive `omissions: [{ type, ref, reason, recoverable_by }]` to the context.pack /
  context.profile output, behind a `--with-omissions` flag so DEFAULT output stays byte-parity
  with Node. When the compiler selects items under a token budget, record each excluded
  candidate with a reason code (one of: `budget_pressure`, `lower_relevance`, `superseded`,
  `untrusted_source`, `duplicate`, `filtered_secret`) and a `recoverable_by` hint (the query/
  command to retrieve it).
- Gate (`scripts/rust-omission-quality.mjs`): on the OAF repo with a tight token budget, assert
  the pack returns a non-empty omissions list with valid reason codes + recoverable_by; assert
  default (no flag) output is byte-parity with Node; assert at least the `budget_pressure` and
  `superseded` reasons appear when a superseded fact and an over-budget candidate exist.
Commit: `feat: add context omission manifest`.

## S2 — Evidence & provenance chains (auditability)
Mission: answer "why does OAF believe this, and why is it current truth?" for any fact.
- Add `oaf memory why <fact-id>` (CLI + MCP `memory.why`) returning the provenance chain:
  source locator → episode → proposal → fact, plus the supersession history (what it superseded
  and what superseded it), confidence, and validity interval. Read-only; current-truth aware;
  temporal `--at` supported.
- Gate (`scripts/rust-provenance-quality.mjs`): build the notes-api supersession scenario
  (token_expiry 60→15); `memory why <15min-fact>` must return its source/episode/proposal AND
  that it superseded the 60min fact (with the 60min's own chain reachable); `memory why
  <60min-fact>` shows it superseded + by what. Assert the chain is complete and acyclic.
Commit: `feat: add memory provenance/why query`.

## S3 — Taint / trust labels + policy receipts (trust & authority)
Mission: external/untrusted content can be SEEN and PROPOSED but cannot silently become truth or
trigger actions — the prompt-injection / memory-poisoning defense.
- Every fact/edge carries a `trust_level` (`trusted_local` for first-party ingest/decisions;
  `untrusted_external` for content from tool output / web / flagged sources). Policy: an
  `untrusted_external` fact may be PROPOSED (pending) but MUST go through approval — it can NEVER
  auto-activate (even via the single-remember auto-active path). It may not request consequential
  tools. Emit a `policyReceipt: { decision, matched_rule, side_effect_class, trust_level,
  approval }` on memory commit and on tool/grant decisions.
- Gate (`scripts/rust-trust-quality.mjs`): a fact tagged `untrusted_external` via single
  `remember` does NOT auto-activate (stays pending, requires approval) while a `trusted_local`
  one behaves as today; injection-style content (object containing an instruction/tool-request
  pattern) is tagged untrusted and blocked from auto-commit; the policy receipt is emitted with
  the right trust_level. Existing trusted flows unchanged (byte-parity on pre-existing fields).
Commit: `feat: add taint trust labels and policy receipts`.

## S4 — Conflict surfacing in current-truth (governance integrity)
Mission: when two active facts genuinely conflict, SURFACE it — never silently pick.
- When recall/current-truth finds ≥2 active facts for the same (subject, predicate) that are NOT
  linked by supersession (a real conflict), add an additive `conflicts: [{ subject, predicate,
  values:[...], factIds:[...] }]` to the recall output (additive; default fields stay byte-parity)
  and do NOT silently drop either — report both with the conflict marker.
- Gate (`scripts/rust-conflict-quality.mjs`): create two active facts for (auth, token_expiry)
  with different objects and NO supersession link; assert recall reports the conflict (both
  values + factIds) rather than returning one silently; assert a properly superseded pair is NOT
  flagged as a conflict.
Commit: `feat: surface current-truth conflicts`.

## S5 — Capstone: inspectable-session demo + honest report (verification of the whole story)
Mission: prove the inspectable layer end-to-end on a REAL repo, honestly.
- Add `oaf demo inspectable-session` (+ `scripts/rust-inspectable-eval.mjs`): on a real repo,
  run ingest → context pack (with omissions) → recall (with provenance + conflicts + trust
  levels) → loop verify, and emit one coherent inspectability report: included vs omitted context
  (+ reasons), per-fact provenance, trust levels, any conflicts, and the governed decisions.
- Gate: end-to-end on the OAF repo + notes-api; assert the report contains a non-empty omission
  manifest, at least one provenance chain, trust levels, and (in a constructed case) a surfaced
  conflict. Report an HONEST measure of the value (e.g. count of context items the omission
  manifest exposes that a naive include-only flow would hide). No strawman, no cherry-pick — if
  a number looks too good, scrutinize and report why.
Commit: `feat: add inspectable-session demo and honest eval`.

---

## Definition of done (per milestone + overall)
- [ ] Based on m9-langs; M1-M9 still pass before S1 and after EACH milestone (no regression).
- [ ] Each completed milestone: its gate passes; existing surfaces stay byte-parity on
      pre-existing fields; new surfaces quality-verified on a real repo; checkpoint committed.
- [ ] Node `npm run ci` green (435) at every checkpoint; only `/rust` + new harness scripts touched.
- [ ] Honest report per milestone (numbers + what's NOT handled) and an explicit note if any
      milestone was STOPPED (and why) rather than degraded.

## Reporting
End with: per-milestone status (done / stopped-with-reason), each gate's result, the capstone
inspectability report + its honest value number, the final harness/CI state, and an explicit
"stopped / unhandled / open questions" list. Real numbers only.
