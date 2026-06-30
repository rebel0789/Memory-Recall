# CLAUDE.md

Honest, code-grounded orientation for AI assistants working in this repo. The
goal here is clarity about **what actually exists in the code today** — not the
roadmap. The markdown docs (`AGENTS.md`, `PROJECT_STATUS.json`, `docs/`)
describe an ambitious platform vision; this file describes the implementation.

> Reality check: this repo is a small, **dependency-free, deterministic
> reference baseline** (~2,300 lines across `packages/`), not the full platform
> the docs describe. Most packages are a single `.mjs` file demonstrating one
> primitive. Treat docs as intent and the code below as ground truth.

## Status map — what the code actually does

Legend: **Built** = real, working logic · **Partial** = a thin/narrow slice ·
**Absent** = described in docs but no implementation.

### Built

- **Context compilation / token budgeting** — `packages/context-compiler/src/index.mjs`
  is the most substantial real component. Given an objective, a step, a token
  budget, and candidate records, it produces a **context manifest**: which
  records were *selected* vs *excluded*, each with reason codes. Scoring blends
  lexical overlap, entity relations, authority, confidence, recency, importance,
  outcome-evidence, and a retrieval penalty; forced-governance records bypass
  scoring; a per-kind diversity penalty discourages monoculture; basic conflict
  detection groups records by `conflictKey`. `estimateTokens` is `length/4`.
- **Workspace memory store** — `providers/native/memory-sqlite/src/index.mjs`
  (~315 lines): real SQLite + FTS5, workspace-scoped, with record lifecycle and
  `supersedes` links.
- **Protocol / schemas** — `packages/protocol/` has a dependency-free JSON-Schema
  subset validator (`schema-validator.mjs`) and ~40 schemas under `schemas/`,
  plus ID/timestamp helpers. `npm run protocol:validate` exercises fixtures.
- **Storage repositories** — `packages/storage/` has a file-backed store and a
  PostgreSQL repository layer (`postgres-repositories.mjs`,
  `postgres-migrations.mjs`) driven through `psql`.
- **Control API + web/CLI** — `services/control-api/` serves a local HTTP API and
  a dependency-free dashboard; `apps/web` and `apps/cli` are the clients.
- **Replay** — `packages/replay/` builds side-effect-free replay plans and run
  comparisons.

### Partial

- **Memory write gate** — `packages/memory-core/src/index.mjs` is **14 lines**:
  secret-pattern blocking and propose-vs-review gating. It governs writes; it is
  not a memory system on its own (the SQLite provider above is the store).
- **Tool registry** — `packages/tool-registry/src/index.mjs` is **17 lines**:
  manifest lookup only. It does not execute tools.
- **Agent Packs** — `packages/agentpack/` validates and fingerprints portable
  pack declarations. Declaration/validation exists; runtime activation is thin.
- **Model gateway** — `packages/model-gateway/src/index.mjs` is a **deterministic
  content-generation stub** with hardcoded templates. There is no real LLM
  integration; `OAF_MODEL_MODE` other than `deterministic` throws (no fallback).

### Absent (described in docs, not in code)

- **Graphs / knowledge graph** — no graph engine, no traversal, no pgvector.
  "Relations" are plain string arrays on records, used only as scoring keywords.
  The only "graph" is a *disabled* external adapter contract (fixtures), not an
  implementation.
- **Skill execution** — `skills/*/SKILL.md` + `manifest.json` are *declarative*
  procedures meant to be loaded into an agent's context. **No code in this repo
  loads or runs them**; there is no skill runtime.
- **Durable workflows, production auth, real network connectors, external
  publishing** — specified in `PROJECT_STATUS.json`, not implemented.

## Layout (where to look)

```
packages/         provider-neutral primitives (one .mjs file each, mostly)
  context-compiler/   token-budgeted context selection + manifests  ← key code
  memory-core/        memory write gate
  protocol/           schemas + dependency-free validator + IDs
  storage/            file + postgres repositories
  replay/, policy/, evidence/, tool-registry/, agentpack/, model-gateway/
providers/native/  local baselines (memory-sqlite is the real one)
services/control-api/  local HTTP API + dashboard projection
apps/web, apps/cli     clients
adapters/          DISABLED external integration contracts + fixtures (no live code)
skills/            declarative SKILL.md procedures (not executed by any runtime)
tools/manifests/   declared capabilities (lookup only)
workflows/content-intelligence/  deterministic demo vertical slice
tests/             node --test, *.test.mjs  (the real spec of behavior)
docs/              architecture/product/security vision (intent, not status)
planning/backlog.json   OAF task graph (not in active use per project owner)
```

When in doubt about real behavior, **read the matching `tests/*.test.mjs`** — the
tests are the most reliable description of what the code guarantees.

## Working in this repo

Requirements: **Node.js 22+**, ESM only, no runtime npm dependencies.

```bash
npm run bootstrap
npm run dev        # local API + dashboard at http://127.0.0.1:4310
npm test           # node --test tests/*.test.mjs  — start here to understand behavior
npm run check      # repository structure/consistency check
npm run ci         # check + protocol:validate + test + eval
npm run demo       # deterministic content-intelligence workflow end to end
```

Conventions that the existing code actually follows:

- ESM + Node 22 built-ins only; keep the bootstrap dependency-free.
- Small pure functions for selection/policy/transform logic.
- Prefixed IDs, UTC ISO-8601 timestamps, JSON-serializable + versioned payloads.
- Never log credentials/cookies/auth headers or private bodies.
- Add/adjust a `tests/*.test.mjs` when you change behavior; keep `npm run ci` green.

## Note on the OAF task system

The repo ships an `npm run task -- OAF-xxx` backlog workflow. When a task ID is
assigned, follow the root `AGENTS.md` task protocol: run `npm run task -- <ID>`
and load only the listed context before changing code. When no task ID is
assigned, still respect the architecture invariants in `AGENTS.md`: untrusted
external content stays untrusted, memory writes remain proposal-gated, and
authority is deterministic code rather than model output.
