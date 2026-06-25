# Loop Workbench — SUPER GOAL (one unattended run, A-to-Z native tool)

Attach this whole file as a single goal. It builds the **full native Loop
Workbench tool** in one long unattended run: loop engineering, token/memory
savings, and the two skills — Slices 1 through 5 plus the Action and Intent
skills, in dependency order.

It is engineered to **degrade gracefully**: the agent commits after every slice
that passes CI and stops at the first slice that fails. So whatever you wake up to
is real, green, and mergeable up to the last commit — never a tangled half-build.

Full slice specifications live in
[docs/product/loop-workbench-build-plan.md](../../product/loop-workbench-build-plan.md)
Section 4. This file is the sequencing + checkpoint protocol that runs them all in
one go.

---

## Scope (A-to-Z, native providers only)

IN scope this run:

```text
Slice 1  Loop Plan generator            (read-only)
Slice 2  Observation capture            (bounded validate)
Slice 3  Maker/checker verifier         (bounded action, isolated worktree)
Slice 4  Loop orchestration + schedule  (durable)
Slice 5  Loop Workbench UI              (web)
Skill A  Action-stage efficiency skill  (ponytail-style: reuse before generate)
Skill B  Intent-stage clarification skill (grilling-style)
```

OUT of scope this run (cannot be done offline/unattended — needs network,
services, and the adapter promotion gate; do NOT attempt):

```text
Temporal, Pydantic AI, pgvector, Mem0, Graphify, OpenTelemetry, any external
adapter, any runtime npm dependency, any network call, any model API call.
```

Token and memory savings ARE delivered natively: the `contextBudget` measured
field (Slice 1), governed proposal-only memory (already in repo), and the
reuse-before-generate skill (Skill A). Savings are reported as measured numbers,
never advertised as unproven claims.

---

## Checkpoint protocol (the rule that makes this safe — obey exactly)

Build the slices strictly in order: 1 → 2 → 3 → 4 → 5 → Skill A → Skill B.

For **each** item:

1. Implement it per its spec in `loop-workbench-build-plan.md` Section 4 (Slices)
   or Section 5 (Skills).
2. Run, in order: focused tests → `npm run protocol:validate` →
   `node scripts/check.mjs` → `npm run ci`.
3. **If CI is green:** commit immediately with a conventional message
   (`feat: loop workbench slice N ...`). Then proceed to the next item.
4. **If CI is not green after 3 focused fix attempts:** STOP the whole run. Do not
   touch later slices. Leave the last green commit as the tip. Append a short note
   to `LOOP_WORKBENCH_BLOCKERS.md` (which slice, what failed, the exact failing
   command + last error, what you tried). Then report and exit.

Never start slice N+1 while slice N is red. Never weaken or delete a test to make
CI pass — that is the overfitting failure mode and it defeats the whole tool. If a
real test is wrong, fix the code, not the test; if you cannot, treat it as a
blocker per step 4.

---

## Branch setup

```bash
cd "/Users/rebel/Downloads/open-agent-fabric 2"
git worktree add -b codex/loop-workbench-super ../oaf-loop-workbench oaf/OAF-031-context-intake-harness-bridge
cd ../oaf-loop-workbench
```

Leave `CLAUDE.md` and `.claude/` untracked and out of every commit.

---

## Global rules (apply to all slices)

Obey the Unattended Run Rules in `loop-workbench-build-plan.md` Section 2:
one coherent change at a time, missing-file = create per spec, **reuse before
writing** (the `buildContextPack*` sanitizer/redaction/fingerprint helpers, the
event ledger, the flight recorder, the workflow runtime, the JSON-schema
validator — do not author new ones), small reversible diffs, anti-thrashing
(3-attempt cap), honest `PROJECT_STATUS.json` updates, no new authority beyond
each slice's stated side-effect class.

Side-effect classes escalate only as specified: Slice 1 read-only; Slice 2 runs
ONLY the loop plan's declared `validationCommands`; Slice 3 writes ONLY inside an
isolated worktree behind the checker, no auto-merge; Slice 4 bounded by
maxIterations/timeout/stopReasons with human approval thresholds; Slice 5
read-only views + existing approved write paths.

---

## Prompt to attach to the goal

```text
You are working in Open Agent Fabric. This is the Loop Workbench SUPER GOAL:
build the full native tool in one run, Slices 1-5 plus Skill A and Skill B, in
dependency order.

Read first: docs/product/loop-workbench-build-plan.md (Sections 2, 4, 5) and
docs/product/loop-workbench.md. Then read only the files each slice's spec names.

Obey the Checkpoint Protocol exactly: implement each item in order; run focused
tests -> npm run protocol:validate -> node scripts/check.mjs -> npm run ci; if
green, COMMIT and continue; if still red after 3 focused attempts, STOP, leave the
last green commit as the tip, append the blocker to LOOP_WORKBENCH_BLOCKERS.md,
and report. Never advance on red. Never weaken a test to pass CI.

In scope: Slices 1-5 (loop plan, observation capture, maker/checker verifier, loop
orchestration + scheduling, web UI) + Skill A (reuse-before-generate action skill)
+ Skill B (intent clarification skill). Out of scope: Temporal, Pydantic AI,
pgvector, Mem0, Graphify, OpenTelemetry, any external adapter, any runtime
dependency, any network, any model API call.

Reuse before writing. Keep tests few and high-value (one focused file per slice).
Update PROJECT_STATUS.json honestly. Do not claim more than is committed and green.
Stop when Slice 5 + both skills are committed green, OR at the first blocker.
Report using the repo handoff template: list every committed slice and its CI
status, and any blocker.
```

---

## What you check in the morning

```bash
cd ../oaf-loop-workbench
git log --oneline           # one commit per green slice = your salvage points
cat LOOP_WORKBENCH_BLOCKERS.md   # exists only if it stopped early; says where + why
npm run ci                  # confirm the tip is green
npm run oaf -- loop plan --read-only --root . --objective "demo" \
  --stop-condition "tests pass" --validation "node --test tests/web-shell.test.mjs"
```

Each commit is independently mergeable. If it stopped at Slice 4, Slices 1-3 are
still real, green bricks you keep. Tell me where it landed and the blocker, and I
will harden the next run from exactly that point.

---

## Honest expectation

A clean 7-hour run can plausibly land Slices 1-3 solidly and reach into 4-5.
Reaching all five plus both skills in one unattended run is possible but not
guaranteed — that is why the checkpoint protocol exists. You lose nothing either
way: you keep every green commit, and the blocker note tells us exactly where to
resume. The full best-in-class infra (Temporal etc.) is a separate, awake,
gated step after the native tool is green.
