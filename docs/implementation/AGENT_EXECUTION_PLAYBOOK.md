# Agent Execution Playbook

## Objective

Let a coding agent make reliable progress without loading the entire repository or inventing missing decisions.

## Session loop

### 1. Establish reality

```bash
npm run bootstrap
npm run doctor
npm run status
npm run verify:handoff
```

Read `PROJECT_STATUS.json`. Do not infer implementation from future-looking docs.

### 2. Select exactly one task

```bash
npm run status
npm run task -- <OAF-ID>
```

Use the objective, dependencies, deliverables, stop condition, required reading, and commands printed. If a dependency is incomplete, stop and report it.

### 3. Build a minimal context pack

Load root `AGENTS.md`, the nearest directory `AGENTS.md`, governing schema/ADR, task files, and tests. Do not load every adapter, research note, or skill.

### 4. Preflight trust and side effects

Write down actor, workspace, inputs, data classes, files, network, secrets, side-effect class, approval, idempotency, migration, and rollback. Stop for review at any root security stop condition.

### 5. Implement the smallest coherent slice

Prefer a failing test followed by a narrow fix. Keep contracts provider-neutral. Do not refactor unrelated code.

### 6. Verify progressively

Run the nearest unit test, then package tests, then `npm run ci`. For UI work, complete the manual design matrix. For selector or model changes, run relevant evaluations.

### 7. Update truth

Update docs, examples, schemas, changelog, and `PROJECT_STATUS.json` only when behavior changed and tests prove it. Generate a repository manifest at release or handoff boundaries.

### 8. Handoff

Use the template in `ASSIGN_TO_AGENT.md`. Include exact commands and results, not “tests passed” without evidence.

## Context hygiene

- Keep a short task ledger outside the model call.
- Prefer IDs and links over copied bodies.
- Compact completed history into verified decisions, not speculative summaries.
- Retrieve details only after an index or exact reference identifies them.
- Preserve rejected alternatives only when they prevent repeated work.

## Failure rules

Stop rather than guess when acceptance conflicts with an ADR, a schema change lacks compatibility policy, a secret or external write appears, an upstream license is uncertain, or test evidence cannot reproduce a claimed behavior.
