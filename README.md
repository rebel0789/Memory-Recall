# Open Agent Fabric

<p align="center">
  <img src="assets/brand/wordmark.svg" alt="Open Agent Fabric" width="520">
</p>

**Open Agent Fabric (OAF)** is a local-first reliability and context operating system for AI agents. It keeps context intentional, capabilities controlled, decisions evidence-backed, runs replayable, memory governed, and agent definitions portable.

This repository is an **agent-ready development kit**, not a claim that the full production platform already exists. It contains a runnable offline vertical slice, native local provider baselines, stable contracts, brand and product guidance, security boundaries, deterministic tests and evaluations, a machine-readable backlog, and disabled integration contracts for upstream projects studied during architecture research.

> Build the whole tool. Own the boundaries. Integrate only when the contract is clear.

## Ship-ready local memory path

OAF now has a verified local profile for governed coding-agent memory over a
real workspace. It ingests repository facts into a local SQLite store as
proposals, requires explicit approval before facts become ACTIVE, serves active
facts first through read-only MCP, and sends cursor deltas during a session so
repeat pulls do not resend the same context.

Verified local benchmarks:

- Temporal correctness: `oaf bench temporal --read-only --root .` returned
  `100%` correct and `100%` clean for current facts while stale values were
  present in the raw timeline.
- Session delivery: `oaf bench session --read-only --root .` returned `100%`
  correctness and a `76%` delivered-token reduction versus full resend
  (`651` delta tokens vs `2664` full-resend tokens). This is the measured
  session-delta path, not a provider billing claim.
- Real repo questions: `oaf bench realqa --read-only --root .` returned `100%`
  after structured governed ingest on 12 questions derived from this repo.

Plain tradeoff: on static lookup, OAF ties keyword search more than it beats it.
The edge is correctness when facts change, proposal governance before trust, and
cheap repeat delivery through MCP cursors. It does not claim semantic retrieval,
generic token savings versus RAG, hosted memory, or cloud sync.

## What works now

- dependency-free Node.js 22 bootstrap with no API key, paid service, database
  server, model API, or external network required;
- native SQLite/FTS5 governed memory with temporal facts, supersession, entity
  edges, proposal queue, explicit approve/reject, and no hard delete;
- `oaf memory ingest --root . --sqlite .local/memory.sqlite` for deterministic
  offline extraction from git history, key docs, project status, provider
  manifests, and source-graph hints into PENDING proposals only;
- `oaf memory review`, `oaf memory approve`, and `oaf memory reject` for the
  trust step from candidate proposal to ACTIVE fact;
- `oaf memory remember --batch facts.json` for host-agent extracted memory maps
  from `skills/oaf-memory`, including supersession and confidence labels;
- read-only `oaf mcp server` exposing `memory.recall`, `context.profile`, and
  `context.pack` over local stdio with active facts separated from proposals;
- persisted MCP cursors and `since` deltas so repeat `memory.recall` and
  `context.profile` calls send only changed current truth, including after a
  restart;
- preview-then-confirm MCP install for Claude Code, Cursor, and Codex with an
  absolute server path, explicit project root, explicit project SQLite memory
  path, and no silent home config write;
- `/memory` cockpit over the loopback Control API with temporal facts, proposal
  counts, MCP delivery stats, and confirm-gated proposal approval;
- deterministic local benches for temporal correctness, session delta delivery,
  and real repo question answering;
- local HTTP control API, CLI, responsive evidence-first dashboard, Context
  Compiler, context manifests, native source graph preview, bounded local
  workflow provider, deterministic model provider, content-addressed artifact
  provider, policy/tool primitives, Agent Pack validation, tests, evaluations,
  repository checks, and release manifests.

## What is deliberately not claimed

Production PostgreSQL repositories, production authentication, semantic
retrieval, hosted embeddings, vector databases, hosted memory sync, write-capable
MCP tools, automatic harness history import, silent or broad harness config
writes outside confirmed MCP install, real social connectors, hardened
sandboxes, external publishing, signed Agent Pack distribution, and a production
frontend framework are **not claimed**. Durable workflow and source-graph
providers exist as local references; team/cloud production remains outside the
local profile. `PROJECT_STATUS.json` is the machine-readable source for current
capability status and limitations.

## Quickstart: governed memory in Claude Code

Requirement: Node.js 22 or newer.

Local package path, from this repository:

```bash
npm pack
npm install -g ./open-agent-fabric-0.2.0-dev.tgz
oaf setup
oaf verify
oaf connect codex --dry-run --format json
oaf hook install --agent codex --dry-run --format json
oaf hook install --agent claude-code --dry-run --format json
```

Source-checkout path, without a global install:

```bash
npm run oaf -- setup
npm run oaf -- verify
npm run oaf -- connect codex --dry-run --format json
npm run oaf -- hook install --agent codex --dry-run --format json
npm run oaf -- hook install --agent claude-code --dry-run --format json
```

`setup` runs the existing local bootstrap. `verify` runs the handoff
verification gate. `connect --dry-run` previews the read-only MCP and hook
setup. `connect --yes` is the narrow opt-in writer for Codex and Claude Code
home config; it creates backups and receipts and can be undone with
`disconnect --yes`. Hook install/uninstall commands remain dry-run receipt and
manual-snippet commands. The tarball is local-install ready; the npm registry
and marketplace are not published.

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run local:run

# Preview the exact Claude Code MCP config. This writes nothing.
npm --silent run oaf -- mcp install --client claude-code --root "$PWD" --sqlite "$PWD/.local/memory.sqlite" --dry-run --format json
# Short default preview also works: npm run oaf -- mcp install --client claude-code --dry-run --format json

# Apply only after preview by feeding the matching fingerprint back.
CONFIRM="$(npm --silent run oaf -- mcp install --client claude-code --root "$PWD" --sqlite "$PWD/.local/memory.sqlite" --dry-run --format json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).planFingerprint))')"
npm --silent run oaf -- mcp install --client claude-code --root "$PWD" --sqlite "$PWD/.local/memory.sqlite" --apply --confirm "$CONFIRM" --format json

# Populate governed memory from this repo. Ingest creates proposals, not trust.
npm --silent run oaf -- memory ingest --root . --sqlite .local/memory.sqlite --format json
npm --silent run oaf -- memory review --root . --sqlite .local/memory.sqlite --format json

# Promote reviewed facts explicitly. Use a narrower source when you want less.
npm --silent run oaf -- memory approve --all-from workspace://PROJECT_STATUS.json --root . --sqlite .local/memory.sqlite --format json

# Pull what a coding agent receives over the read-only MCP server.
printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory.recall","arguments":{"client":"readme-quickstart","query":"default durable workflow provider","scope":"workspace","limit":8}}}' \
'{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"context.profile","arguments":{"client":"readme-quickstart","objective":"default durable workflow provider","scope":"workspace","limit":8,"budget":512}}}' \
| npm --silent run oaf -- mcp server --read-only --root "$PWD" --sqlite "$PWD/.local/memory.sqlite" --stdio
```

The install command writes only the `oaf` MCP server entry after
`--apply --confirm`; the server remains read-only and local stdio. The memory
commands never auto-activate facts. Rejections and supersessions are recorded,
not hard-deleted.

Manual install flow: run `npm run oaf -- mcp install --client claude-code --dry-run --format json`,
review the preview, then run the printed `--apply --confirm <fingerprint>`
command. The installed server does not import harness history, enable write
tools, call cloud/model APIs, or claim provider billing-token savings.
In short: it does not import harness history, enable write tools, call cloud/model APIs, or claim provider billing-token savings.

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
loopback API. Verified pins expose a browser **Receive pinned pack** action,
copyable receiver packet, read-only receive command, and MCP use-plan read
command; stale or review pins withhold the use-plan resource until the registry
verifies again. Registry verification also redacts unsafe persisted source
locators before status output, so poisoned local metadata cannot surface
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
oaf context handoff --read-only --from codex --root . --objective "Prepare handoff" --step "select next agent context" --target codex --changed apps/web/app.js --format json
```

Add `--memory-config oaf.memory.json` only when you want the report to preflight
explicitly selected local memory source files. The handoff still stays read-only:
it reports proposal/quarantine counts, warning codes, fingerprints, and a dry-run
proposal command, but it does not write proposal files, activate memory, or expose
memory text/source bodies.

For a compact diff-aware impact brief with the same read-only MCP proof:

```bash
oaf measure context-pack --read-only --from codex --root . --objective "Prepare handoff" --step "impact brief" --target codex --changed apps/web/app.js --format json
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
7. `docs/adr/0012-build-the-whole-tool-own-the-boundaries.md`
8. `docs/implementation/AGENT_EXECUTION_PLAYBOOK.md`
9. `npm run task -- <OAF-ID>` only when `npm run status` names a next task

## Product thesis

Most long-running agents do not fail because they lack stored information. They fail because weak, stale, conflicting, unsafe, or irrelevant information competes for attention, while actions and improvements are difficult to inspect.

OAF makes these first-class primitives:

- context selection and context manifests;
- source graph, retrieval, compaction, and code intelligence;
- provenance, temporal validity, and supersession;
- deterministic permissions and approvals;
- hook-driven context routing that never grants authority;
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
npm run oaf -- setup           # local bootstrap wrapper
npm run oaf -- verify          # handoff verification wrapper
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
oaf context handoff --read-only --from codex --root . --objective "Prepare handoff" --step "select next agent context" --target codex --changed apps/web/app.js --format json
npm run oaf -- mcp resources --read-only --context-pack --from codex --objective "Prepare handoff" --step "select next agent context" --target codex --changed apps/web/app.js --uri oaf://workspace/ws_local/context-pack/current --format json
npm run oaf -- mcp smoke context-pack --read-only --from codex --objective "Prepare handoff" --step "select next agent context" --target codex --changed apps/web/app.js --format json
npm run oaf -- context graph preview --root . --query "approve token reset" --trace runAuthWorkflow --changed src/auth.ts --dry-run --format json
npm run oaf -- harness setup status --client codex --dry-run --format json
npm run oaf -- harness setup plan --client cursor --server oaf --dry-run --format json
npm run oaf -- hook install --agent codex --dry-run --format json
npm run oaf -- hook uninstall --agent codex --dry-run --format json
npm run dev                    # local API and dashboard
npm run ci                     # checks, protocol, tests, evaluations
npm run verify:handoff         # full handoff gate plus manifests
npm run manifest               # file hashes for release and review
```

## Integration policy

The core is Apache-2.0. Upstream projects are research inputs, benchmark inputs, or optional integration targets; their source is not vendored. OAF owns the default local tool experience. Every external integration records an exact commit, checksum, license review, trust boundary, capability set, installation mode, maintainer, and conformance evidence before it can be enabled.

Read:

- `docs/adr/0012-build-the-whole-tool-own-the-boundaries.md`
- `docs/architecture/native-providers.md`
- `docs/architecture/adapter-contracts.md`
- `adapters/CONFORMANCE.md`
- `docs/open-source/fork-policy.md`
- `THIRD_PARTY.md`

## Status

Development kit: **0.2.0-dev**. Run `npm run status` for the current checked-in task state. Run `npm run task -- <OAF-ID>` only when status names a next task.

| Surface | Status |
| --- | --- |
| Source checkout | Local-ready reference path |
| npm package tarball | Local-ready install path |
| npm registry | Not published |
| Marketplace / plugin registry | Not ready |
| Client hooks | Opt-in Codex/Claude connect writer; dry-run/manual fallback |
