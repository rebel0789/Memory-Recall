# Loop Workbench — Full Build Plan

This is the complete, sequenced plan to build the **full working Loop Workbench**
tool: OAF's native loop-engineering surface where a developer designs, runs,
observes, and improves agent feedback loops — safely, cheaply, with proof.

It is built as a sequence of small, independently shippable slices. Each slice is
one safe unattended run that ends CI-green. The slices compose into the whole
tool. No single run tries to build everything — that is the documented failure
mode (unsafe autonomy + thrashing).

Companion docs: [loop-workbench.md](loop-workbench.md) (product north star),
[builder-workspace.md](builder-workspace.md). Per-slice attach prompts are in
this file. Slice 1 also has a standalone attach file at
`docs/superpowers/plans/2026-06-26-loop-workbench-goal-brief.md`.

---

## 1. The full tool at a glance

The loop, governed end to end by primitives OAF already owns:

```text
intent -> context -> action -> observation -> adjustment -> stop or repeat
```

| Loop stage  | Primitive            | Status in repo today                 |
| ----------- | -------------------- | ------------------------------------ |
| intent      | Loop Plan            | ⬜ Slice 1                            |
| context     | Source Graph + Context Compiler + Context Pack | ✅ exists      |
| action      | bounded agent runner + maker/checker | ⬜ Slice 3 (runner specified) |
| observation | event ledger + observation record | ✅ ledger / ⬜ record Slice 2 |
| adjustment  | flight recorder: replay, compare, shadow, proposals | ✅ specified |
| stop/repeat | orchestrator: stop reasons, max iter, timeout | ⬜ Slice 4    |
| surface     | Loop Workbench UI    | ⬜ Slice 5                            |

**"Full tool" is mostly wiring + naming, not greenfield.** Token measurement,
governed memory, scoped graph, locator handoff, and the flight-recorder substrate
already exist. The new work is the orchestration layer (Slices 1–5) plus optional
scale integrations (Section 6) behind existing ports.

**Definition of done for the full tool:** Slices 1–5 green, wired end to end on
the **native** providers (SQLite memory, filesystem artifacts, embedded/durable
workflow, deterministic model), with measured token budgets surfaced per run.
External infrastructure integrations for durable workflows, typed agent runtime,
vector search, memory backends, repository graphs, and telemetry are optional
swaps behind ports, not a precondition.

---

## 2. Shared Unattended Run Rules (apply to every slice)

1. **One slice per run.** Implement only the slice named in the goal. When it is
   complete and `npm run ci` is green, STOP and report. Do not start the next
   slice in the same run.
2. **Missing-file rule.** If a referenced file is absent, create it per its spec
   here. Never hallucinate contents or invent unrelated requirements.
3. **Reuse before writing (ponytail).** Reuse existing helpers — the
   `buildContextPack*` sanitizer/redaction/fingerprint helpers in
   `packages/harness-context/src/index.mjs`, the event ledger, the flight
   recorder, the workflow runtime, the JSON-schema validator. Do not author new
   regex sanitizers or parallel fingerprint schemes.
4. **No new authority beyond the slice's stated side-effect class.** No runtime
   deps, no network, no model calls, no external writes, no automatic memory
   activation, no browser/account automation, no external adapters — unless the
   slice spec explicitly grants it, bounded.
5. **Anti-thrashing.** If a test will not pass after 3 focused attempts, record
   the blocker and stop. Do not rewrite large surfaces speculatively.
6. **Small reversible diffs.** Keep the diff inside the slice's file list. No
   unrelated refactors or reformatting. Never touch `CLAUDE.md` / `.claude/`.
7. **Verification is the gate.** Done = focused tests → `npm run protocol:validate`
   → `node scripts/check.mjs` → `npm run ci`, in that order.
8. **Honesty.** Update `PROJECT_STATUS.json` truthfully (`specified` until a slice
   is implemented + tested, then `reference`). Never claim more than is built.
9. **Commit discipline.** Small conventional commits (`feat:`/`test:`/`docs:`).

---

## 3. Build sequence (dependency order)

```text
Slice 1  Loop Plan generator            (read-only)        ← foundation
Slice 2  Observation capture            (bounded validate) ← needs 1
Slice 3  Maker/checker verifier         (bounded action)   ← needs 1,2
Slice 4  Loop orchestration + schedule  (durable)          ← needs 1,2,3
Slice 5  Loop Workbench UI              (web)              ← needs 1–4

Skills   ponytail action skill + grilling intent skill     ← any time after 1
Scale    durable runtime / typed runtime / vector DB / memory / graph / telemetry  ← last, gated
```

Each slice builds only on merged, green predecessors. Fire them one per night.

---

## 4. Slice specifications

Each slice lists: **Goal · Adds · New artifacts · Reuses · Side-effect class ·
Definition of Done · Hard boundaries · Attach prompt.**

### Slice 1 — Read-only Loop Plan generator

- **Goal:** deterministic, sanitized loop plan from objective, stop condition,
  validation commands, Source Graph hints, and Context Pack / use-plan refs.
- **Adds:** the loop's `intent` spine; a measured `contextBudget`.
- **New artifacts:** `loop-plan.schema.json`; valid + invalid fixtures;
  `buildLoopPlan()` in harness-context; `recall loop plan` CLI; one focused test.
- **Reuses:** buildContextPack sanitizer/fingerprint; schema validator.
- **Side-effect class:** read-only (no file reads in the helper, no commands).
- **DoD:** schema + 2 fixtures + helper + CLI + 1 test file + PROJECT_STATUS entry
  (`builder.loop-workbench`, status `specified`) + CI green.
- **Boundaries:** no executor, no command run, no observation, no UI, no deps.
- **Attach prompt:** use the standalone file
  `docs/superpowers/plans/2026-06-26-loop-workbench-goal-brief.md`.

### Slice 2 — Sanitized observation capture

- **Goal:** run a Loop Plan's **own** `validationCommands** and record their
  results to the event ledger — redacted, read-only, no raw transcripts.
- **Adds:** the loop's `observation` stage. First place commands run, tightly
  bounded.
- **New artifacts:** `loop-observation.schema.json` (records per command: the
  command string, exit code, duration ms, pass/fail, a **redacted** truncated
  output summary, and a content hash — never raw multi-KB logs); valid + invalid
  fixtures; `recordLoopObservation()` helper; `recall loop observe` CLI; one focused
  test.
- **Reuses:** event ledger (append observation events); redaction helpers; the
  Loop Plan as the source of which commands are allowed to run.
- **Side-effect class:** read-only on the workspace, but **executes only the exact
  `validationCommands` already declared in the supplied Loop Plan** — no arbitrary
  shell, no injection, no commands not in the plan. Each command runs with a
  timeout from the plan.
- **DoD:** schema + 2 fixtures + helper + CLI + 1 test (asserts: only plan
  commands run; output is redacted + truncated; exit/duration recorded; secrets
  never surface; no writes outside the ledger) + CI green.
- **Boundaries:** no model, no network, no editing files, no memory activation,
  no command outside the plan's `validationCommands`.
- **Attach prompt:**
  ```text
  You are working in Memory Recall. Obey the Unattended Run Rules in
  docs/product/loop-workbench-build-plan.md. Base on the merged Slice-1 branch;
  create a worktree codex/loop-workbench-slice-2.

  Implement Slice 2 only: sanitized observation capture, per Section 4 of
  docs/product/loop-workbench-build-plan.md. Read only: that plan, the Slice-1
  loop-plan.schema.json + buildLoopPlan, the event-ledger module, and the existing
  redaction helpers.

  Execute ONLY the validationCommands declared in the supplied loop plan, capture
  exit code + duration + a redacted truncated output summary + a content hash to
  the event ledger, and validate against loop-observation.schema.json. No
  arbitrary shell, no file edits, no model, no network, no memory activation.
  Few high-value tests (one file). Stop when npm run ci is green; do not start
  Slice 3.
  ```

### Slice 3 — Maker/checker verifier (agents monitoring agents)

- **Goal:** one bounded loop iteration — an **implementer** sub-agent makes a
  change in an isolated worktree; a **checker** sub-agent runs the plan's
  validation (Slice 2) and a scope check (no unrelated diff), under the flight
  recorder; output is a verification report + a proposal. **No auto-merge.**
- **Adds:** the `action` + `adjustment` stages; the reliability core.
- **New artifacts:** `loop-verification-report.schema.json`;
  `runLoopVerification()` orchestration (implementer→checker→report); `recall loop
  verify` CLI; fixtures; one focused test.
- **Reuses:** flight recorder (record/replay-without-effects/compare/shadow),
  git worktrees, policy + approval gate, Slice-2 observation capture, the Agent
  tool / bounded runner.
- **Side-effect class:** local-write **inside an isolated worktree only**, gated
  by the checker; the main branch is never written without a human approval.
- **DoD:** schema + fixtures + orchestration + CLI + 1 test (asserts: checker runs
  the plan's validation; unrelated-diff is flagged as `unrelated_changes`; a
  failed check blocks the proposal; no auto-merge; flight-recorder events emitted;
  replay disables side effects) + CI green.
- **Boundaries:** no auto-merge, no approval reuse, no unbounded retries (cap at
  the plan's `maxIterations`), no external writes, no network in replay.
- **Attach prompt:**
  ```text
  You are working in Memory Recall. Obey the Unattended Run Rules in
  docs/product/loop-workbench-build-plan.md. Base on merged Slice-2; worktree
  codex/loop-workbench-slice-3.

  Implement Slice 3 only: the maker/checker verifier, per Section 4. An
  implementer sub-agent makes a bounded change in an isolated git worktree; a
  checker sub-agent runs the loop plan's validationCommands (Slice 2) plus an
  unrelated-diff scope check; emit a loop-verification-report and a proposal.
  Record both sides via the flight recorder. NO auto-merge, no approval reuse, cap
  iterations at the plan's maxIterations, replay disables side effects. Reuse the
  flight recorder, policy/approval gate, and Slice-2 capture. One focused test
  file. Stop when npm run ci is green; do not start Slice 4.
  ```

### Slice 4 — Loop orchestration + scheduling

- **Goal:** run the full loop `intent→context→action→observation→adjustment→stop`
  over the **durable workflow runtime**, bounded by `maxIterations`/`timeout`/
  `stopReasons`; plus cadence automations (triage, PR-babysitter, CI-sweeper) as
  durable workflows with aggregated token budget.
- **Adds:** the `stop/repeat` controller; "loops that prompt you."
- **New artifacts:** `loop-run.schema.json` + `loop-run-log` projection;
  `runLoop()` workflow definition; `recall loop run` + `recall loop schedule` CLI;
  fixtures; one focused test.
- **Reuses:** workflow-runtime + durable-sqlite provider (durable state/recovery),
  event ledger (run log), Slice-1/2/3 primitives, `contextBudget` aggregation for
  loop-budget tracking.
- **Side-effect class:** governed by the resolved plan; default read-only/
  local-write with human approval thresholds; denylist + MCP scope limits.
- **DoD:** schema + run-log + workflow + CLI + 1 test (asserts: loop stops on each
  stopReason; respects maxIterations + timeout; durable resume after restart;
  aggregated token budget reported; human gate enforced) + CI green.
- **Boundaries:** bounded iterations only, no unattended external writes without
  approval, no silent cloud fallback, scheduling is opt-in.
- **Attach prompt:**
  ```text
  You are working in Memory Recall. Obey the Unattended Run Rules in
  docs/product/loop-workbench-build-plan.md. Base on merged Slice-3; worktree
  codex/loop-workbench-slice-4.

  Implement Slice 4 only: loop orchestration + scheduling, per Section 4. Drive
  intent→context→action→observation→adjustment→stop over the durable workflow
  runtime, bounded by maxIterations/timeout/stopReasons, with a durable run log
  and aggregated token budget. Add opt-in cadence automations (triage,
  PR-babysitter, CI-sweeper) as durable workflows with human approval thresholds.
  Reuse workflow-runtime + durable-sqlite + event ledger + Slices 1-3. One focused
  test file (stop reasons, bounds, durable resume, budget, human gate). Stop when
  npm run ci is green; do not start Slice 5.
  ```

### Slice 5 — Loop Workbench UI

- **Goal:** the `/loop-workbench` web route — create a plan, view runs,
  observations, verification reports, token budget, and stop reasons; evidence
  first (outcome → explanation → trace).
- **Adds:** the `surface`.
- **New artifacts:** web route + components in `apps/web`; control-API read
  endpoints; one focused web-shell test.
- **Reuses:** apps/web shell, control-api, all Slice-1/4 read models.
- **Side-effect class:** read-only views + plan creation through the existing
  control API; no new authority.
- **DoD:** route renders plan/run/observation/verification/budget; loopback API
  endpoints; 1 focused web-shell test; CI green.
- **Boundaries:** no production framework, no new build tooling, dependency-free
  per the bootstrap profile; no write actions beyond existing approved paths.
- **Attach prompt:**
  ```text
  You are working in Memory Recall. Obey the Unattended Run Rules in
  docs/product/loop-workbench-build-plan.md. Base on merged Slice-4; worktree
  codex/loop-workbench-slice-5.

  Implement Slice 5 only: the /loop-workbench web route, per Section 4. Evidence-
  first views over the existing read models: plan, runs, observations,
  verification reports, token budget, stop reasons. Read-only views plus plan
  creation via the existing control API. Dependency-free bootstrap profile, no new
  build tooling. One focused web-shell test. Stop when npm run ci is green.
  ```

---

## 5. Cross-cutting skills (add any time after Slice 1)

- **Action-stage efficiency skill (ponytail-style).** A model-invoked
  `SKILL.md` that enforces reuse-before-generate and the smallest change that
  works, applied during the loop's action stage. Adopt the laziness-ladder idea
  as a skill; do not vendor the framework. This is the per-iteration token-saving
  engine; its effect is measured via `contextBudget`/diff size, cited honestly.
- **Intent-stage clarification skill (grilling-style).** A skill that interrogates
  the objective and stop condition before the loop starts, closing the intent gap.
  Mirrors the `.claude/skills` + `SKILL.md` convention already used in this repo.

Each ships as a small skill folder with focused tests, not a subsystem.

---

## 6. Best-of-best infra — optional swaps behind existing ports (last, gated)

These are **optional integration slices**, not the default product path. Each implements a port the
native baseline already implements, and stays **disabled until pinned, licensed,
SBOM-checked, reviewed, and conformance-tested** (the existing adapter promotion
gate). OAF owns the user-facing tool; integrations only replace bounded internals.

| Concern             | Native baseline (built)        | Optional integration target          |
| ------------------- | ------------------------------ | ------------------------------------ |
| Durable workflow    | embedded + durable-sqlite      | **Temporal**                         |
| Typed agent runtime | deterministic runner           | **Pydantic AI** (OTel built-in)      |
| Memory / vector     | SQLite + FTS5                  | reviewed memory/vector integration   |
| Repo graph          | native source graph            | reviewed graph integration           |
| Observability       | event ledger + flight recorder | reviewed telemetry integration       |
| Tool transport      | brokered-local                 | **MCP** connectors                   |

The 2026 reference pairing (Temporal + Pydantic AI, durable + typed + OTel) is
already named in the architecture diagram; this plan finishes the wiring behind
the ports rather than adopting a new stack.

---

## 7. Honesty stance

Until a slice is implemented and tested, its capability stays `specified` in
`PROJECT_STATUS.json`, and docs say "planned, not shipped." Token/memory savings
are reported as measured numbers per run (`contextBudget`,
`observedDeliveryReductionRatio`), never advertised as unproven claims. External
agent-efficiency results are cited as that tool's measured effect, not OAF's.
This honesty is the brand; the loop work must not break it.
