# Assignment Brief for the Development Agent

You are working on **Memory Recall 2.0.0**, currently a major-release candidate. Evolve it through small verified changes. Do not rebuild the architecture from scratch and never claim that specified capabilities already exist.

## Mission

Build the local-first repository memory and context tool that gives coding agents reviewed facts, source-backed context, changed-file impact, and inspectable handoffs without making a hosted service the system of record.

## First session

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run bootstrap
npm run doctor
npm run verify:handoff
npm run status
```

Open <http://127.0.0.1:4310> after `npm run dev`.

Read, in order:

1. `AGENTS.md`
2. `PROJECT_STATUS.json`
3. `PRODUCT.md`
4. `DESIGN.md`
5. `docs/START_HERE.md`
6. `docs/adr/0012-build-the-whole-tool-own-the-boundaries.md`
7. `docs/implementation/AGENT_EXECUTION_PLAYBOOK.md`
8. the nearest package-level `AGENTS.md`

## Current task

Use `npm run status` to identify the current checked-in task. Run
`npm run task -- <OAF-ID>` only when status names a next task. When status says
the checked-in backlog is complete, do not invent a task; use the current
release-readiness and usage docs as the active boundary. Keep native providers
as conformance baselines. Do not expand into migration orchestration, UI work,
or external adapters unless the active task explicitly requires it.

## Product differentiator

Memory Recall does not win by bundling repositories or outsourcing its core product behavior. It owns:

- intentional context selection and context manifests;
- source graph, retrieval, compaction, and code intelligence for the default local experience;
- temporal, evidence-backed memory lifecycle;
- deterministic authority and capability grants;
- project-scoped hooks that improve routing and performance without granting authority;
- an agent flight recorder with replay and shadow mode;
- reviewable learning proposals instead of silent self-modification;
- portable Agent Packs;
- provider and adapter conformance.

Build the product core. Use hooks and integrations as bounded accelerators only. Fork only through an approved RFC.

## Non-negotiable discipline

- One architectural concern per pull request.
- Add a test before or with behavior.
- Run `npm run ci` before handoff.
- Treat external content and model output as untrusted.
- Keep external adapters disabled until pinned, licensed, reviewed, and tested.
- Preserve the dependency-free offline bootstrap.
- Never make authorization, approvals, or permanent memory a model decision.
- Never enable external publishing by default.
- Update `PROJECT_STATUS.json` only when tests prove a capability changed.
- Do not let provider IDs or SDK objects become canonical domain state.

## Required handoff after every task

```text
Task and stop condition:
Files changed:
Behavior added or corrected:
Tests and evaluations run:
Security and permission impact:
Data or migration impact:
Known limitations:
Rollback:
Safest next task:
```

## Product success

A contributor can install Memory Recall in another repository, produce a useful read-only map and handoff, inspect exactly which context and evidence it selected, and review every memory proposal before it becomes active.
