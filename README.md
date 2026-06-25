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
- preview-only harness context compiler path with selected/excluded safe
  locators, proposal-only memory plan, token-ratio metrics, and deterministic
  benchmark gates;
- dry-run context pack builder for Codex, Claude Code, Cursor, and generic
  agents, producing a schema-validated locator handoff with compact source
  graph hints, explicit user-selected file locators, a utility read plan with
  changed-file coverage, a copyable launch prompt, and a delivery-budget metric
  distinct from source-body token counts, without raw source bodies or automatic
  memory import;
- read-only context impact brief for the current checkout, reporting changed
  coverage, affected symbols, required local reads, omitted counts, hashes,
  source-selection reduction, and MCP readback proof without raw code or writes;
- opt-in read-only MCP context-pack summary resource for local harnesses,
  exposing locators, hashes, token counts, omissions, changed-file impact, and
  utility coverage counts without raw task text, source bodies, markdown
  bodies, or write tools;
- local MCP context-pack stdio smoke report with observed duration, response
  size, selected/candidate source units, and delivered-handoff unit counts for
  one explicit local invocation;
- read-only Codex handoff preflight report that combines the launch prompt,
  required local reads, schema-validated use plan, MCP context-pack readback
  proof, and dry-run setup preview without writing harness config;
- read-only native JS/TS source graph preview through CLI and loopback API,
  with bounded search, trace, diff-impact results, 256 KiB default file
  coverage for static JS/TS, and no graph database;
- dry-run harness setup planner for local MCP client configs, with redacted
  status, add, replace, and uninstall previews and no home config writes;
- versioned contract fixtures for 12 disabled external adapter targets;
- tests, evaluations, repository checks, and agent task tooling;
- no API key, paid service, database server, or external network required.

## What is deliberately not claimed

Production PostgreSQL repositories, crash-resumable workflow orchestration, production authentication, proposal-based harness context import, automatic harness history import, write-capable MCP tools, real harness config writes, real social connectors, hardened sandboxes, external publishing, signed Agent Pack distribution, and a production frontend framework are **specified and planned**, but not completed. `PROJECT_STATUS.json` is the machine-readable source for current capability status and limitations.

## Start in five minutes

Requirement: Node.js 22 or newer.

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run bootstrap
npm run verify:handoff
npm run dev
```

Open <http://127.0.0.1:4310>. If the browser asks for local owner setup or
sign-in, complete that before running dashboard actions. CLI-only setup is also
available without putting a password on the command line:

```bash
printf '%s\n' 'correct horse battery staple' | \
  npm run auth:bootstrap -- --username owner --display-name "Local Owner" --password-stdin
```

First practical path: open **Context Pack**, keep the target as Codex or choose
your local harness from **Inputs to review**, click **Preview sources**, use
**Detect current git changes** or add changed files manually, optionally list
reviewed memory preflight sources, then build the pack. Use the **Practical
handoff** path: copy Markdown or the launch prompt, copy/download
`oaf.memory.json` only if you chose memory files, run the read-only handoff
preflight command, and preview MCP setup only when the target harness should
read OAF resources. The brief shows
changed-file coverage, required reads, hash proof, affected symbols, and proof
commands without source bodies. Fabric Map and Agents & Tools show the same
current handoff status without installing anything. This is a dry-run locator
handoff with read-only MCP proof; it does not import harness history, create
active memory, write harness config, or enable external adapters.

If the repository already has an explicitly pinned CLI handoff, the Context Pack
page also shows **Pinned handoff status** by reading
`context-packs/registry.json` and `context-packs/current.json` through the
loopback API. Verified pins expose a read-only receive command and MCP use-plan
read command; stale or review pins withhold the use-plan resource until the
registry verifies again. Registry verification also redacts unsafe persisted
source locators before status output, so poisoned local metadata cannot surface
provider URLs, session-token strings, or absolute user paths as trusted status.

For a pinned local pack that another harness can consume without retyping the
objective, write and pin first, then receive the pinned artifact:

```bash
npm run oaf -- context pack --from codex --root . --objective "Prepare handoff" --step "select next agent context" --target codex --write --pin --out context-packs/CONTEXT_PACK.md --format json
npm run oaf -- context receive --read-only --root . --target codex --format json
```

`context receive` reads `context-packs/current.json`, the pinned use-plan, and
the registry only. It returns `ready`, `review`, or `blocked` with hashes,
required local reads, a compact `receiverPacket`, MCP zero-tool proof, and
harness status; it does not rebuild the pack, accept objective/step text, write
files, or expose raw source or Markdown bodies. Direct
`--context-pack-use context-packs/*.use.json` MCP reads are also rejected before
resource exposure if the use-plan contains unsafe local paths, provider URLs,
session/token markers, or secret-like strings.

For a single CLI preflight before handing work to Codex:

```bash
npm --silent run oaf -- context handoff --read-only --from codex --root . --objective "Prepare handoff" --step "select next agent context" --target codex --changed apps/web/app.js --format json
```

Add `--memory-config oaf.memory.json` only when you want the report to preflight
explicitly selected local memory source files. The handoff still stays read-only:
it reports proposal/quarantine counts, warning codes, fingerprints, and a dry-run
proposal command, but it does not write proposal files, activate memory, or expose
memory text/source bodies.

For a compact diff-aware impact brief with the same read-only MCP proof:

```bash
npm --silent run oaf -- measure context-pack --read-only --from codex --root . --objective "Prepare handoff" --step "impact brief" --target codex --changed apps/web/app.js --format json
```

Use `--format summary` for a compact operator-facing stdout report over the
same validated measurement object.

The measurement report includes selected/delivered handoff token estimates,
observed local build/readback timings, and aggregate changed-file body tokens
kept out of the handoff. It does not claim provider billing tokens, production
latency, raw source inclusion, model calls, network calls, or external writes.

For the full copy-paste operator path across the browser, CLI, Codex, Cursor,
and Claude Code, read `docs/usage/local-agent-handoff.md`.

The offline bootstrap installs no runtime npm dependencies. The optional Ollama provider requires a separately installed loopback Ollama server and never falls back to a cloud model.

## Give this repository to a coding agent

Tell the agent:

```text
Read ASSIGN_TO_AGENT.md and AGENTS.md. Run `npm run verify:handoff`, then `npm run status`.
If status names a next OAF task, run `npm run task -- <OAF-ID>` and complete that task only. If status says the backlog is complete, do not invent a task.
Keep npm run ci green, and report using the required handoff template for task work.
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
9. `npm run task -- <OAF-ID>` only when `npm run status` names a next task

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
npm run task -- <OAF-ID>       # only when status names a next task
npm run doctor                 # environment and local safety checks
npm run protocol:validate      # v1 valid, invalid, and compatibility fixtures
npm run native:smoke           # native memory, artifacts, Agent Pack, model
npm run demo                   # complete synthetic workflow
npm run oaf -- context scan --from codex --root . --dry-run
npm run oaf -- context preview --from codex --root . --objective "Prepare handoff" --step "select harness context" --dry-run
npm run oaf -- context pack --from codex --root . --objective "Prepare handoff" --step "select next agent context" --target codex --include-file CONTEXT.md --changed apps/web/app.js --dry-run --format markdown
npm run oaf -- context pack --from codex --root . --objective "Prepare handoff" --step "select next agent context" --target codex --write --out context-packs/CONTEXT_PACK.md --format json
npm run oaf -- context pack --from codex --root . --objective "Prepare handoff" --step "select next agent context" --target codex --write --pin --out context-packs/CONTEXT_PACK.md --format json
npm run oaf -- context receive --read-only --root . --target codex --format json  # after --write --pin
npm --silent run oaf -- context handoff --read-only --from codex --root . --objective "Prepare handoff" --step "select next agent context" --target codex --changed apps/web/app.js --format json
npm run oaf -- mcp resources --read-only --context-pack --from codex --objective "Prepare handoff" --step "select next agent context" --target codex --changed apps/web/app.js --uri oaf://workspace/ws_local/context-pack/current --format json
npm run oaf -- mcp smoke context-pack --read-only --from codex --objective "Prepare handoff" --step "select next agent context" --target codex --changed apps/web/app.js --format json
npm run oaf -- context graph preview --root . --query "approve token reset" --trace runAuthWorkflow --changed src/auth.ts --dry-run --format json
npm run oaf -- harness setup status --client codex --dry-run --format json
npm run oaf -- harness setup plan --client cursor --server oaf --dry-run --format json
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

Development kit: **0.2.0-dev**. Run `npm run status` for the current checked-in task state. Run `npm run task -- <OAF-ID>` only when status names a next task.
