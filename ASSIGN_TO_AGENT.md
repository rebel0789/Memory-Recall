# Assignment Brief for the Development Agent

You are receiving an agent-ready development kit for **Open Agent Fabric 0.2.0-dev**. Evolve it through small verified changes. Do not rebuild the architecture from scratch and never claim that specified components already exist.

## Mission

Build a local-first reliability and context operating system for agents whose state, actions, evidence, memory, workflows, permissions, and improvements are portable and inspectable.

## First session

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run bootstrap
npm run doctor
npm run verify:handoff
npm run status
npm run task -- <OAF-ID>
```

Open <http://127.0.0.1:4310> after `npm run dev`.

Read, in order:

1. `AGENTS.md`
2. `PROJECT_STATUS.json`
3. `PRODUCT.md`
4. `DESIGN.md`
5. `docs/START_HERE.md`
6. `docs/adr/0012-build-the-brain-adapt-the-organs.md`
7. `docs/implementation/AGENT_EXECUTION_PLAYBOOK.md`
8. the nearest package-level `AGENTS.md`

## Current task

Use `npm run status` and `npm run task -- <OAF-ID>` to identify the current checked-in task. Keep native providers as conformance baselines. Do not expand into migration orchestration, UI work, or external adapters unless the active task explicitly requires it.

## Product differentiator

Open Agent Fabric does not win by bundling repositories. It owns:

- intentional context selection and context manifests;
- temporal, evidence-backed memory lifecycle;
- deterministic authority and capability grants;
- an agent flight recorder with replay and shadow mode;
- reviewable learning proposals instead of silent self-modification;
- portable Agent Packs;
- provider and adapter conformance.

Build the brain; adapt the organs. Fork only through an approved RFC.

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

A contributor can run one useful local workflow, inspect exactly what context and evidence it used, replay it without side effects, replace a model or backend without losing portable state, and understand every consequential action before it occurs.
