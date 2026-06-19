# Repository Map and Ownership

## Entry points

- `ASSIGN_TO_AGENT.md` — first instruction for an implementation agent.
- `AGENTS.md` — repository-wide operating invariants.
- `PROJECT_STATUS.json` — evidence-based implemented/reference/planned status.
- `planning/backlog.json` — machine-readable task dependency graph.
- `docs/START_HERE.md` — documentation index.
- `HANDOFF_VERIFICATION.json` — most recent full local verification.
- `REPOSITORY_MANIFEST.json` — reproducible file hashes.

## Runtime and interfaces

- `services/control-api/` — local HTTP boundary and dashboard projection.
- `apps/web/` — dependency-free conformance UI.
- `apps/cli/` — local CLI.
- `workflows/content-intelligence/` — complete deterministic vertical slice.

## Provider-neutral domain packages

- `packages/protocol/` — schemas, dependency-free validation, IDs, event types.
- `packages/context-compiler/` — selection and context-manifest logic.
- `packages/memory-core/` — memory proposal gate.
- `packages/evidence/` — normalization and citation validation.
- `packages/policy/` — deterministic authorization.
- `packages/tool-registry/` — manifest-backed capability invocation.
- `packages/model-gateway/` — deterministic local bootstrap boundary.
- `packages/workflow-runtime/` — bounded runner and cancellation semantics.
- `packages/storage/` — file-backed reference state.
- `packages/adapter-contracts/` — ports, provider envelopes, conformance helpers.
- `packages/agentpack/` — portable Agent Pack validation, resolution, fingerprinting.
- `packages/replay/` — safe replay plans, run comparisons, learning proposals.
- `packages/ui/` — executable design tokens.

## Providers and integrations

- `providers/native/` — local baseline implementations; read `providers/AGENTS.md`.
- `adapters/` — disabled external integration contracts and expectation fixtures.
- `adapters/CONFORMANCE.md` — promotion requirements.
- `THIRD_PARTY.md` — upstream and license boundary register.

Core packages never import providers or adapters. Providers and adapters implement core ports. Application composition selects implementations.

## Agent assets

- `agents/` — role definitions. An agent role never grants permissions by itself.
- `skills/` — procedures loaded only when triggered.
- `tools/manifests/` — declared capabilities and risk.
- `examples/agentpacks/` — portable agent definitions without credentials.

## Governance and quality

- `evals/` — deterministic regression cases.
- `tests/` — contract, unit, provider, and security tests.
- `docs/adr/` — accepted architecture decisions.
- `rfcs/` — proposed protocol changes.
- `.github/` — issue, pull-request, security, and CI automation.
- `deploy/` — optional local and team infrastructure.

## Ownership rule

The nearest `AGENTS.md` applies in addition to the root file. Schema, event, authorization, migration, Agent Pack, provider contract, and design-token changes require a single integration owner and explicit review.
