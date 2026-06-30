# Loop Workbench Goal Brief — Slice 1 (hardened for unattended run)

Attach this whole file as the goal for Codex / Claude / another coding agent.
It is self-contained. The agent reads only this brief plus the repo files listed
below. The first build goal is intentionally small: ship the **read-only Loop
Plan generator** before any loop executor, observation capture, or UI.

This version is hardened for an **unattended overnight run**. Read the
"Unattended Run Rules" section first — they are the guardrails that keep a
6–7 hour run from drifting into scope creep, thrashing, or unsafe actions.

---

## Unattended Run Rules (read first, obey for the whole run)

1. **Scope lock.** Implement **Slice 1 only**. When Slice 1 is complete and
   `npm run ci` is green, **STOP and report.** Do not begin Slice 2, observation
   capture, summaries, templates, an executor, or any UI — even if time remains.
2. **Missing-file rule.** If a file in the read list does not exist in your
   worktree, **create it per its spec in this brief** (see Step 0 for
   `docs/product/loop-workbench.md`). Never invent unrelated requirements or
   hallucinate the contents of a missing file.
3. **Reuse before writing (ponytail discipline).** Before writing new code, reuse
   what exists. The locator sanitization, redaction, and fingerprint helpers used
   by the `buildContextPack*` family in `packages/harness-context/src/index.mjs`
   (the same ones `verifyContextPackRegistry()` relies on) must be reused — do
   **not** author a new regex sanitizer or a second fingerprint scheme.
4. **No new authority.** No runtime npm dependencies, no network, no model calls,
   no external writes, no command execution inside the helper, no automatic
   memory activation, no browser/account automation, no external adapters.
5. **Anti-thrashing.** If a test will not pass after **3 focused attempts**, stop
   changing code. Record the blocker in the PR description (or a short note in the
   branch) and stop. Do not rewrite large surfaces hoping something sticks.
6. **Small reversible diffs.** Keep the diff scoped to the "Likely files" list.
   Do not refactor unrelated code, reformat untouched files, or touch
   `CLAUDE.md` / `.claude/`.
7. **Verification is the gate.** "Done" means `npm run ci` passes — not "looks
   right." Run the focused tests, then protocol validation, then the repo check,
   then full CI, in that order.
8. **Honesty.** Update `PROJECT_STATUS.json` truthfully. Do not claim Loop
   Workbench is shipped. Slice 1 ships only the Loop Plan primitive.
9. **Commit discipline.** Commit in small logical chunks with conventional commit
   messages (`feat:`, `test:`, `docs:`). Keep `CLAUDE.md` and `.claude/` out of
   every commit.

---

## Branch Setup

Do **not** start from `main`. In this checkout, `main` is only the initial
snapshot. Base on the current OAF-031 branch — it contains the Source Graph and
Context Pack foundation this slice reuses.

Preferred clean setup (isolated worktree):

```bash
cd "/Users/rebel/Downloads/open-agent-fabric 2"
git worktree add -b codex/loop-workbench-slice-1 ../oaf-loop-workbench oaf/OAF-031-context-intake-harness-bridge
cd ../oaf-loop-workbench
```

If already in a clean OAF-031 checkout, this is also acceptable:

```bash
git switch oaf/OAF-031-context-intake-harness-bridge
git switch -c codex/loop-workbench-slice-1
```

Do not mix unrelated local setup files into this work. If `M CLAUDE.md` or
`?? .claude/` appear in status, leave them untracked and uncommitted.

---

## Goal Title

```text
Build OAF Loop Workbench Slice 1: read-only Loop Plan generator
```

## Goal Objective

```text
Implement the first shippable Loop Workbench primitive: a schema-backed,
read-only Loop Plan generator that turns an objective, stop condition, validation
commands, Source Graph hints, and Context Pack / use-plan references into a
deterministic, sanitized loop plan that carries a measured context budget.
```

---

## Prompt To Attach To The Goal

```text
You are working in Open Agent Fabric.

Follow AGENTS.md and the repo instructions. Obey the "Unattended Run Rules" in
this brief for the entire run. Read only the context needed for this slice:

1. PROJECT_STATUS.json
2. docs/product/loop-workbench.md   (create per Step 0 if it is missing)
3. docs/product/builder-workspace.md
4. docs/architecture/overview.md
5. docs/architecture/flight-recorder.md
6. docs/architecture/context-compiler.md
7. packages/harness-context/src/index.mjs
8. apps/cli/oaf.mjs
9. packages/protocol/schemas/context-pack.schema.json
10. packages/protocol/schemas/context-pack-use-plan.schema.json
11. packages/protocol/schemas/context-pack-measurement-report.schema.json
    (for the contextBudget field-name idiom only)

Task: Implement Slice 1 only — the read-only Loop Plan generator.

Hard boundaries:
- Do not add a new executor.
- Do not run user commands as part of loop planning.
- Do not add observation capture yet.
- Do not build the web UI yet.
- Do not add runtime dependencies.
- Do not add external adapters.
- Do not activate memory automatically.
- Do not add hidden transcript capture.
- Do not add browser/account automation.
- Do not add unbounded autonomous retries.
- Do not claim Loop Workbench is fully shipped.

Expected behavior:
The CLI can generate a sanitized loop plan from a user objective, stop condition,
validation commands, optional changed locators, optional selected files, and
optional context-pack/use-plan references. The plan is schema-backed,
deterministic, read-only, and safe to hand to another local coding agent.

Reuse, do not reinvent:
- Reuse the existing locator sanitizer / redaction / fingerprint helpers from the
  buildContextPack family in packages/harness-context/src/index.mjs. Do not write
  a new regex sanitizer or a second fingerprint scheme.

When Slice 1 is complete and `npm run ci` is green, STOP and report using the
repo's handoff template. Do not continue into observation capture, proof summary,
templates, executor, or UI.
```

---

## Slice 1 Detailed Build Checklist

### Step 0. Ensure the product doc exists

If `docs/product/loop-workbench.md` is missing in your worktree, create it first.
Minimum required content (a fuller version may already exist in the source
checkout — prefer that if present):

- Title "Loop Workbench" and the loop line
  `intent -> context -> action -> observation -> adjustment -> stop or repeat`.
- A table mapping each loop stage to its backing OAF primitive (intent→Loop Plan,
  context→Source Graph/Context Compiler/Context Pack, action→bounded runner,
  observation→event ledger/flight recorder, adjustment→compare/shadow/proposals,
  stop→stop reasons/max iterations/timeout).
- A "Why this saves tokens and memory" section: scoped Source Graph, locator-only
  Context Pack, Context Compiler selection, and a measured delivery budget
  (`contentTokenCount`, source-body tokens excluded, `observedDeliveryReduction`)
  — savings are proven per run, not claimed.
- A "What is not claimed" section: observation capture, verifier, scheduling, UI,
  and any executor are specified and planned, not shipped.

### 1. Protocol Schema

Add `packages/protocol/schemas/loop-plan.schema.json`. Keep it strict:

- `additionalProperties: false`
- string length limits
- bounded arrays
- fingerprints for references
- explicit enums for risk and side effects

Recommended enums:

```text
riskClass: low | review | high
sideEffectClass: read-only | local-write | external-write
stopReason:
  completed | validation_failed | blocked_missing_input | blocked_needs_human
  | unsafe_action_required | max_iterations | timeout | unrelated_changes
  | out_of_scope
```

These `stopReason` values are the loop-engineering anti-patterns made explicit:
`unrelated_changes`/`out_of_scope` guard against thrashing and scope creep,
`unsafe_action_required`/`blocked_needs_human` against unsafe autonomy,
`validation_failed` against overfitting to a green test.

Slice 1 defaults:

```text
sideEffectClass = read-only
approvalRequired = false
maxIterations = 3
timeoutSeconds = 1800
```

**New required field — `contextBudget`.** Add an object that records the token
economics of the plan, mirroring the field-name idiom in
`context-pack-measurement-report.schema.json`:

```text
contextBudget:
  estimatedDeliveryTokens   (integer >= 0)
  sourceBodyTokensExcluded  (integer >= 0)
  deliveryReductionRatio    (number 0..1)   # mirrors observedDeliveryReductionRatio
  basis                     (enum: context-pack-measurement | unestimated)
```

The plan **carries** these numbers from the supplied context-pack / use-plan
references (which were measured upstream). The helper does **not** read files to
compute them. If no measured references are supplied, set `basis = unestimated`
and zeros. This is what makes the token saving honest and visible per plan.

Group the schema fields logically: identity (`schemaVersion`, `id`,
`workspaceId`, `createdAt`, `loopPlanFingerprint`), intent (`objective`,
`stopCondition`, `nonGoals`), bounds (`riskClass`, `sideEffectClass`,
`maxIterations`, `timeoutSeconds`, `approvalRequired`), references
(`sourceGraph`, `contextPack`, `requiredLocalReads`, `validationCommands`,
`contextBudget`), control (`stopReasons`, `rollback`, `safeguards`).

### 2. Fixtures

Add one valid example:

```text
examples/protocol/loop-plan.json
```

Add one invalid example proving raw/private data is rejected:

```text
examples/protocol/compatibility/invalid/loop-plan-raw-body.json
```

Do not add a large fixture set.

### 3. Helper Function

Add the smallest helper in `packages/harness-context/src/index.mjs`:

```js
buildLoopPlan({
  workspaceId,
  objective,
  stopCondition,
  nonGoals,
  validationCommands,
  changedLocators,
  userSelectedFiles,
  contextPack,
  usePlan,
  sourceGraph,
  contextBudget,   // optional measured budget carried from a context-pack measurement
  clock
})
```

The helper must:

- normalize workspace-relative locators;
- reject unsafe strings **using the existing sanitizer** (absolute paths, private
  local paths, raw source bodies, secrets, tokens, authorization headers,
  cookies, provider URLs, API keys);
- derive required local reads from explicit files and context-pack/use-plan data;
- record Source Graph and Context Pack fingerprints when supplied;
- populate `contextBudget` from the supplied measurement (else `unestimated`);
- produce deterministic IDs/fingerprints from stable input (reuse the existing
  fingerprint helper);
- return a JSON-serializable object that passes `loop-plan.schema.json`.

Do **not** read files, run git, or run commands inside this helper.

### 4. CLI Command

Add:

```bash
npm run oaf -- loop plan --read-only --root .
```

Minimum flags:

```text
--workspace-id  --objective  --stop-condition  --non-goal  --validation
--changed-locator  --include-file  --format json  --read-only  --root
```

JSON output is enough for Slice 1. Markdown can wait.

### 5. Tests (few, high-value — do NOT build a large matrix)

Add one focused file: `tests/harness-context-loop-plan.test.mjs`. Test only:

- valid plan builds deterministically (stable id + fingerprint for stable input);
- raw source / private path / secret-like input is rejected;
- validation commands are recorded but never executed;
- required reads stay workspace-relative;
- no model/network/write flags are present in output;
- `contextBudget` reflects the supplied measurement and excludes source-body
  tokens (and is `unestimated` when no measurement is supplied).

Update `tests/cli.test.mjs` only enough to cover `loop plan` parsing/output.

### 6. Status Update

Add a new capability to `PROJECT_STATUS.json` (status enum in this repo is
`specified | reference | experimental | disabled`):

```text
id: builder.loop-workbench
name: Loop Workbench (Loop Plan generator)
status: specified   # move to "reference" only after Slice 1 is implemented + tested
evidence: [
  packages/protocol/schemas/loop-plan.schema.json,
  examples/protocol/loop-plan.json,
  examples/protocol/compatibility/invalid/loop-plan-raw-body.json,
  packages/harness-context/src/index.mjs,
  apps/cli/oaf.mjs,
  tests/harness-context-loop-plan.test.mjs,
  tests/cli.test.mjs,
  docs/product/loop-workbench.md
]
limitations: [
  "Read-only Loop Plan generator only.",
  "Observation capture, proof summary, verifier, scheduling, UI, and executor are not implemented.",
  "contextBudget is an estimate carried from a context-pack measurement; it does not claim provider billing tokens."
]
```

---

## Focused verification (run in this order)

```bash
node --test tests/harness-context-loop-plan.test.mjs tests/cli.test.mjs
npm run protocol:validate
node scripts/check.mjs
```

## Final verification before claiming complete

```bash
npm run ci
```

---

## Suggested CLI shape

```bash
npm run oaf -- loop plan --read-only --root . \
  --objective "Fix source graph report filtering" \
  --stop-condition "Focused web shell test passes and no unrelated diff" \
  --validation "node --test tests/web-shell.test.mjs"
```

## Likely files (keep the diff inside this set)

```text
packages/protocol/schemas/loop-plan.schema.json
examples/protocol/loop-plan.json
examples/protocol/compatibility/invalid/loop-plan-raw-body.json
packages/harness-context/src/index.mjs
apps/cli/oaf.mjs
tests/harness-context-loop-plan.test.mjs
tests/cli.test.mjs
PROJECT_STATUS.json
docs/product/loop-workbench.md
docs/product/builder-workspace.md   (only if behavior wording needs correction)
```

---

## What Success Looks Like

After Slice 1, one command yields a safe plan like:

```text
Objective: Fix source graph report filtering.
Stop: focused web shell test passes and no unrelated diff.
Context: selected files and Source Graph hints (locators + hashes, no bodies).
Context budget: ~X delivery tokens; Y source-body tokens excluded; basis measured.
Action boundary: read-only plan only.
Validation: node --test tests/web-shell.test.mjs.
Stop reasons: completed, validation_failed, blocked_needs_human, unsafe_action_required.
Rollback: discard this slice branch/worktree.
Safeguards: no model, no network, no writes, no active memory.
```

That is the first real Loop Workbench brick.

## What NOT To Do In Slice 1

Observation capture; proof summary; `/loop-workbench` web route; reusable loop
templates; background worker; autonomous agent runner; command execution engine;
browser automation; remote adapter; memory activation; model-based judge.

Those are later slices, only after the Loop Plan primitive is real and green.

## After Slice 1

Next goal: **Build OAF Loop Workbench Slice 2: sanitized observation capture.**
Only then move toward the maker/checker verifier, then scheduling, then UI.
