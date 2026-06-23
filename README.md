# Open Agent Fabric

<p align="center">
  <img src="assets/brand/wordmark.svg" alt="Open Agent Fabric" width="520">
</p>

**Open Agent Fabric (OAF)** is a local-first reliability and context operating system for AI agents. It keeps context intentional, capabilities controlled, decisions evidence-backed, runs replayable, memory governed, and agent definitions portable.

This repository is an **agent-ready development kit**, not a claim that the full production platform already exists. It contains a runnable offline vertical slice, native local provider baselines, stable contracts, brand and product guidance, security boundaries, deterministic tests and evaluations, a machine-readable backlog, and disabled adapter contracts for the upstream projects studied during architecture research.

> Build the brain. Adapt the organs. Fork only when ownership is unavoidable.

## What works now

- dependency-free Node.js 22 bootstrap;
- local HTTP control API, CLI, and responsive evidence-first dashboard;
- deterministic Content Intelligence vertical slice;
- Context Compiler with selected and excluded context reason codes;
- dependency-free JSON Schema subset validator and compatibility fixtures;
- provider-neutral ports and conformance helpers;
- native SQLite + FTS5 workspace memory provider;
- native content-addressed filesystem artifact provider;
- cancellable embedded workflow provider with event checkpoints;
- deterministic model provider and optional loopback-only Ollama provider;
- portable Agent Pack validation, resolution, and deterministic fingerprinting;
- side-effect-free replay plans, run comparison, and reviewable learning proposals;
- dry-run harness context scanner for documented Codex, Claude Code, and Cursor
  project files, with sanitized reports and no import/write path;
- versioned contract fixtures for 12 disabled external adapter targets;
- tests, evaluations, repository checks, and agent task tooling;
- no API key, paid service, database server, or external network required.

## What is deliberately not claimed

Production PostgreSQL repositories, crash-resumable workflow orchestration, production authentication, proposal-based harness context import, handoff generation, MCP bridge exposure, real social connectors, hardened sandboxes, external publishing, signed Agent Pack distribution, and a production frontend framework are **specified and planned**, but not completed. `PROJECT_STATUS.json` is the machine-readable source for current capability status and limitations.

## Start in five minutes

Requirement: Node.js 22 or newer.

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run bootstrap
npm run verify:handoff
npm run dev
```

Open <http://127.0.0.1:4310>.

The offline bootstrap installs no runtime npm dependencies. The optional Ollama provider requires a separately installed loopback Ollama server and never falls back to a cloud model.

## Give this repository to a coding agent

Tell the agent:

```text
Read ASSIGN_TO_AGENT.md and AGENTS.md. Run `npm run verify:handoff`, then `npm run status` and `npm run task -- <OAF-ID>`.
Complete one task only, keep npm run ci green, and report using the required handoff template.
```

The operating path is:

1. `ASSIGN_TO_AGENT.md`
2. `AGENTS.md`
3. `PROJECT_STATUS.json`
4. `PRODUCT.md`
5. `DESIGN.md`
6. `docs/START_HERE.md`
7. `docs/adr/0012-build-the-brain-adapt-the-organs.md`
8. `docs/implementation/AGENT_EXECUTION_PLAYBOOK.md`
9. `npm run task -- <OAF-ID>`

## Product thesis

Most long-running agents do not fail because they lack stored information. They fail because weak, stale, conflicting, unsafe, or irrelevant information competes for attention, while actions and improvements are difficult to inspect.

OAF makes these first-class primitives:

- context selection and context manifests;
- provenance, temporal validity, and supersession;
- deterministic permissions and approvals;
- an agent flight recorder and safe replay;
- shadow comparisons and learning proposals;
- portable Agent Packs;
- provider and adapter conformance.

> Build agents that remember less, know what matters, and can prove what happened.

## Repository map

- `apps/` — local web and CLI interfaces
- `services/` — application services and control API
- `packages/` — provider-neutral domain packages, schemas, Agent Packs, and replay logic
- `providers/native/` — local baseline provider implementations
- `agents/` — role manifests and operating instructions
- `skills/` — task procedures loaded on demand
- `tools/` — permissioned capability manifests
- `workflows/` — versioned workflow definitions
- `adapters/` — disabled external integration contracts and conformance fixtures
- `evals/` — deterministic regression datasets
- `planning/` — machine-readable delivery backlog
- `docs/` — architecture, product, UX, security, operations, testing, and governance
- `deploy/` — optional self-hosted infrastructure profiles

See `REPOSITORY_MAP.md` for ownership and dependency boundaries.

## Safety defaults

- network denied unless explicitly enabled;
- external writes disabled;
- no silent local-to-cloud fallback;
- no automatic permanent memory;
- no downloaded instruction execution;
- replays always disable external side effects and do not reuse approvals;
- consequential actions require deterministic policy, exact preview, approval, and idempotency;
- third-party adapters remain disabled until pinned, licensed, reviewed, and tested.

## Useful commands

```bash
npm run status                 # implemented, reference, planned, disabled
npm run task -- <OAF-ID>       # current issue-sized assignment bundle
npm run doctor                 # environment and local safety checks
npm run protocol:validate      # v1 valid, invalid, and compatibility fixtures
npm run native:smoke           # native memory, artifacts, Agent Pack, model
npm run demo                   # complete synthetic workflow
npm run oaf -- context scan --from codex --root . --dry-run
npm run dev                    # local API and dashboard
npm run ci                     # checks, protocol, tests, evaluations
npm run verify:handoff         # full handoff gate plus manifests
npm run manifest               # file hashes for release and review
```

## Integration policy

The core is Apache-2.0. Upstream projects are optional adapter targets; their source is not vendored. Every external adapter records an exact commit, checksum, license review, trust boundary, capability set, installation mode, maintainer, and conformance evidence before it can be enabled.

Read:

- `docs/adr/0012-build-the-brain-adapt-the-organs.md`
- `docs/architecture/native-providers.md`
- `docs/architecture/adapter-contracts.md`
- `adapters/CONFORMANCE.md`
- `docs/open-source/fork-policy.md`
- `THIRD_PARTY.md`

## Status

Development kit: **0.2.0-dev**. Run `npm run status` for the next checked-in task and `npm run task -- <OAF-ID>` for its assignment bundle.
