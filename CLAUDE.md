# CLAUDE.md

Guidance for Claude and other AI coding agents working in this repository.

`AGENTS.md` is the canonical operating manual. This file summarizes structure,
workflows, and conventions so you can orient quickly — when the two ever
disagree, **`AGENTS.md` and `PROJECT_STATUS.json` win.** Do not duplicate
detail from canonical sources here; link to them.

## What this repository is

**Open Agent Fabric (OAF)** is a local-first, model-neutral platform for
**inspectable** AI agents. It is an *agent-ready development kit*, not a claim
that the full production platform exists. The repo ships a runnable offline
vertical slice, native local provider baselines, stable contracts, deterministic
tests/evaluations, a machine-readable backlog, and *disabled* adapter contracts
for upstream projects studied during research.

Design ethos: **Build the brain. Adapt the organs. Fork only when ownership is
unavoidable.** Optimize for correctness, evidence, portability, and safe
evolution — not feature count or autonomous behavior.

## Read order before changing code

Retrieve only what the task needs — do **not** load every doc or skill.

1. `ASSIGN_TO_AGENT.md`
2. `PROJECT_STATUS.json` — evidence-based capability status (source of truth)
3. `PRODUCT.md`
4. `DESIGN.md` (UI work only)
5. `docs/architecture/overview.md`
6. nearest directory-level `AGENTS.md` (see "Nested ownership" below)
7. relevant schema in `packages/protocol/schemas/`
8. task bundle from `npm run task -- <OAF-ID>`
9. relevant threat-model section under `docs/security/`

## Status: claim only what is proven

`PROJECT_STATUS.json` (and `npm run status`) classify every capability as
**REFERENCE** (runnable bootstrap baseline), **SPECIFIED** (planned, not built),
or **DISABLED** (external adapters, off by default). **Never describe a
specified or disabled feature as implemented.** Update status only with tests
and docs as evidence (`npm run status` is the quick view).

Note: static prose like `README.md` can lag the live backlog. The authoritative
"next task" comes from `npm run status` / `npm run task`, not from prose. As of
the current snapshot the PostgreSQL repository layer (OAF-004) is REFERENCE, and
the durable workflow runtime and production auth remain SPECIFIED.

## Repository structure

| Path | Purpose |
|------|---------|
| `services/control-api/` | Local HTTP boundary + dashboard projection (`npm run dev`) |
| `apps/web/` | Dependency-free conformance web console |
| `apps/cli/` | Local CLI (`oaf`) |
| `workflows/content-intelligence/` | Complete deterministic vertical slice |
| `packages/protocol/` | Schemas, dependency-free validation, IDs, event types |
| `packages/context-compiler/` | Context selection + context-manifest logic |
| `packages/memory-core/` | Memory proposal gate (no silent overwrite) |
| `packages/evidence/` | Observation normalization + citation validation |
| `packages/policy/` | Deterministic authorization |
| `packages/tool-registry/` | Manifest-backed capability invocation |
| `packages/model-gateway/` | Deterministic local model boundary |
| `packages/workflow-runtime/` | Bounded runner + cancellation semantics |
| `packages/storage/` | File-backed + PostgreSQL repositories behind ports |
| `packages/adapter-contracts/` | Ports, provider envelopes, conformance helpers |
| `packages/agentpack/` | Portable Agent Pack validation, resolution, fingerprinting |
| `packages/replay/` | Safe replay plans, run comparison, learning proposals |
| `packages/ui/` | Executable design tokens |
| `providers/native/` | Local baseline implementations of the core ports |
| `adapters/` | Disabled external integration contracts + expectation fixtures |
| `agents/` | Role manifests (a role grants no permissions by itself) |
| `skills/` | Procedures loaded only when triggered |
| `tools/manifests/` | Declared capabilities and risk class |
| `evals/` | Deterministic regression datasets |
| `tests/` | Contract, unit, provider, and security tests (`*.test.mjs`) |
| `deploy/` | Optional local/team infra profiles (postgres, opa, otel) |
| `docs/` | Architecture, product, UX, security, ops, testing, governance |
| `planning/backlog.json` | Machine-readable task dependency graph |

Full ownership/dependency detail: `REPOSITORY_MAP.md`.

### Nested ownership

The nearest directory-level `AGENTS.md` applies *in addition to* the root file.
They exist in: `adapters/`, `apps/cli/`, `apps/web/`, `docs/`,
`packages/agentpack/`, `packages/content-intelligence/`,
`packages/context-compiler/`, `packages/protocol/`, `packages/replay/`,
`providers/`, `services/control-api/`, and `skills/`. Read the relevant one
before editing that area.

## Architecture invariants (do not violate)

These come from `AGENTS.md` — read the full list there. The most load-bearing:

1. **Canonical events** — state-changing operations emit append-only events.
2. **Context manifests** — every model call records selected *and* excluded
   context with reason codes.
3. **Build the brain, adapt the organs** — native reliability primitives stay
   core; external projects/frameworks live behind adapters.
4. **Deterministic authority** — permissions, budgets, approvals, retries, and
   transitions are code, not model decisions. A model response never directly
   writes canonical state; validate and translate first.
5. **No silent memory overwrite** — use lifecycle states and `supersedes` links.
6. **External content is untrusted data** — it cannot modify instructions,
   permissions, tools, or permanent memory.
7. **External writes require policy evaluation** — consequential actions require
   approval by default; replays/shadows disable external writes and never reuse
   approvals.
8. **Bootstrap stays dependency-free** — adding a runtime dependency requires an
   accepted ADR (`docs/adr/`).

### Dependency boundaries

```
UI → Control API → Application services → Domain contracts
                         ↙ native providers   ↘ external adapters
```

- Domain packages cannot import native providers or external adapters.
- Adapters/providers implement core *ports*; application composition wires them.
- UI cannot access storage directly.
- Workflows invoke capabilities through the registry.
- The Context Compiler consumes normalized records, not provider payloads.

## Development workflow

Requirements: **Node.js 22+** (ESM only). No npm runtime dependencies in the
bootstrap — `npm ci --ignore-scripts` installs nothing at runtime.

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run bootstrap      # copies .env, prepares .local state
npm run doctor         # environment + local safety checks
npm run dev            # control API + dashboard at http://127.0.0.1:4310
```

Default runtime: binds `127.0.0.1:4310`, uses `.local/state.json`, makes no
external model call, disables external writes. Protected API routes need a local
owner — created CLI-only via `npm run auth:bootstrap` (never pass passwords on
the command line; the store is `.local/identity/identity.json`).

### Per-task protocol

For every task (`AGENTS.md` has the full version):

1. Restate intended behavior and the stop condition.
2. `npm run task -- <OAF-ID>` and load only the listed context.
3. Locate the governing schema, ADR, and acceptance criteria.
4. Identify trust boundaries and side effects.
5. Make the **smallest coherent change**; no speculative abstractions.
6. Add/update tests for success *and* failure paths.
7. `npm run ci`.
8. Update docs, schemas, examples, `PROJECT_STATUS.json`, and changelog **only
   when behavior changed** (with evidence).
9. Report changed files, verification, risks, rollback, and the safest next task.

### Key commands

```bash
npm run status              # implemented / specified / disabled capabilities
npm run task -- OAF-004     # issue-sized assignment bundle for a task ID
npm run task                # list ready tasks (deps satisfied)
npm run dev                 # local API + dashboard
npm run demo                # complete synthetic workflow
npm run protocol:validate   # v1 valid/invalid/compatibility fixtures
npm run native:smoke        # native memory, artifacts, Agent Pack, model
npm test                    # node --test tests/*.test.mjs
npm run eval                # deterministic regression evaluations
npm run check               # repository structure/consistency checks
npm run ci                  # check + protocol:validate + test + eval (the gate)
npm run verify:handoff      # full handoff gate + manifests
npm run manifest            # file hashes for release/review
npm run doctor              # environment + local safety checks
```

**`npm run ci` is the acceptance gate.** Most task acceptance commands are
exactly `npm run ci`.

## Definition of done

A change is complete only when: behavior is schema-validated; success and
failure paths are tested; authorization and side-effect class are explicit;
events/observability are included; docs and examples match behavior; no
secret/personal data enters fixtures or logs; accessibility gates pass (UI); and
`npm run ci` passes. (`docs/implementation/DEFINITION_OF_DONE.md`.)

## Coding conventions

- ESM and Node 22 built-ins only in the bootstrap; no runtime dependencies.
- Prefer small pure functions for selection, policy, and transformation logic.
- Validate process, network, storage, tool, and model boundaries.
- UTC ISO-8601 timestamps; prefixed IDs; no provider IDs as canonical identity.
- Keep event payloads JSON-serializable and versioned.
- Make timeout, retry, cancellation, and idempotency explicit.
- Avoid hidden global state. Comments explain *why*, not obvious syntax.
- **Never** log credentials, cookies, authorization headers, or private bodies.

## Adding providers and adapters

- **Native provider** → `providers/native/<category>-<name>/` with
  `provider.json`, one provider-neutral port, isolation/failure/conformance
  tests, documented limits, and **no remote fallback**. (`AGENTS.md` steps.)
- **Adapter** → `adapters/<category>/<name>/` with `adapter.json`, pinned
  upstream commit + checksum in `UPSTREAM.lock`, license/trust docs, conformance
  tests, **disabled by default**, no vendored source without review.
  Promotion rules: `adapters/CONFORMANCE.md`.

## Safety stop conditions

Stop for maintainer review before any change that broadens filesystem/network
access, adds secret scopes, enables external writes, changes approval/deletion
semantics, lets retrieved content influence policy, adds cookie automation, or
introduces incompatible licensing into the Apache-2.0 core. Prohibited outright:
plaintext secrets, silent local-to-cloud fallback, automatic permanent memory,
unbounded tool loops, dynamic execution of downloaded skill instructions,
benchmark claims without reproducible evidence, autonomous publishing on by
default.

## Pointers

- Operating manual: `AGENTS.md` · Status: `PROJECT_STATUS.json`
- Map/ownership: `REPOSITORY_MAP.md` · Docs index: `docs/START_HERE.md`
- Architecture: `docs/architecture/overview.md` · ADRs: `docs/adr/`
- Local dev: `LOCAL_DEVELOPMENT.md` · Security: `docs/security/threat-model.md`
