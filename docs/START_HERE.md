# Documentation Start Here

## For a coding agent

1. `ASSIGN_TO_AGENT.md`
2. `AGENTS.md`
3. `PROJECT_STATUS.json`
4. `npm run status`
5. `npm run task -- <OAF-ID>` only when status names a next task
6. `docs/implementation/AGENT_EXECUTION_PLAYBOOK.md`
7. task-specific files printed by the command, when a task exists

## For product and design

- `PRODUCT.md` — product contract
- `BRAND.md` — identity and voice
- `DESIGN.md` — canonical interface contract
- `docs/product/prd.md` — detailed requirements
- `docs/product/content-intelligence.md` — flagship vertical
- `docs/ux/` — information architecture, flows, components, screens, copy, wireframes, accessibility, QA

## For using OAF today

- `docs/usage/local-agent-handoff.md` — browser and CLI path for handing the
  current repository to Codex, Cursor, Claude Code, or a generic local agent
  with read-only context-pack proof.
- `LOCAL_DEVELOPMENT.md` — local bootstrap, dashboard routes, context-pack
  commands, read-only MCP resources, and harness setup previews.

## For architecture

- `docs/architecture/overview.md`
- `docs/architecture/domain-model.md`
- `docs/architecture/sequence-flows.md`
- `docs/architecture/context-compiler.md`
- `docs/architecture/event-model.md`
- `docs/architecture/storage.md`
- `docs/architecture/workflow-runtime.md`
- `docs/architecture/adapter-contracts.md`
- `docs/architecture/native-providers.md`
- `docs/architecture/agent-packs.md`
- `docs/architecture/flight-recorder.md`
- `docs/adr/0012-build-the-brain-adapt-the-organs.md`
- `docs/architecture/trust-boundaries.md`
- `docs/adr/`
- `rfcs/`

## For implementation

- `docs/implementation/BUILD_ORDER.md`
- `planning/backlog.json`
- `docs/implementation/PR_PLAN.md`
- `docs/implementation/PARALLELIZATION.md`
- `docs/implementation/DEFINITION_OF_DONE.md`

## For security and operations

- `docs/security/threat-model.md`
- `docs/security/data-classification.md`
- `docs/security/tool-permissions.md`
- `docs/security/prompt-injection.md`
- `docs/security/supply-chain.md`
- `docs/security/risk-register.md`
- `docs/operations/`

## For testing and release

- `docs/testing/evaluation-strategy.md`
- `docs/testing/test-matrix.md`
- `docs/testing/adversarial-catalog.md`
- `docs/testing/quality-gates.md`
- `docs/operations/release-checklist.md`
- `docs/open-source/`

Research notes are context, not implementation authority. Load `docs/research/` only when evaluating an adapter or revisiting the original thesis.
