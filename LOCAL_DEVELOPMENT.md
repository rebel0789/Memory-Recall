# Local Development

## Prerequisites

- Node.js 22 or newer.
- Git.
- Docker only for optional infrastructure profiles.

## Offline bootstrap

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run bootstrap
npm run doctor
npm run ci
npm run demo
npm run dev
```

The default binds to `127.0.0.1:4310`, uses `.local/state.json`, makes no external model call, and disables external writes.

Protected API routes require local identity bootstrap:

```bash
printf '%s\n' 'correct horse battery staple' | \
  npm run auth:bootstrap -- --username owner --display-name "Local Owner" --password-stdin
```

Do not pass passwords on the command line. The browser shell can also create
the first owner through `POST /api/auth/bootstrap` when
`GET /api/auth/bootstrap-status` reports `bootstrapRequired: true`. The local
identity store is `.local/identity/identity.json`.

## Fabric map

The Fabric Map page at <http://127.0.0.1:4310/fabric-map> renders a visual
operating map of the local process flow. It shows source intake, normalization,
context compilation, workflow checkpoints, model gateway status, brokered tools,
evidence, memory review, approvals, and disabled external adapter boundaries
from the current loopback dashboard state.

The map is read-only. It does not add telemetry, call models, import harness
chat history, enable adapters, enable external writes, or render raw context
bodies.

## Context pack handoff

The Context Pack page at <http://127.0.0.1:4310/context-pack> builds a
schema-validated handoff for the next local agent. It selects safe workspace
locators from explicit source-family choices for documented Codex, Claude Code,
and Cursor project files, adds
bounded native JS/TS source graph hints, optionally includes explicit
user-selected relative files, and maps explicitly named changed files to compact
impact hints. It then renders Markdown instructions without embedding raw source
bodies or code slices. The pack also includes omitted context refs so a user can
recover skipped local files by locator when the budget or relevance selector
left them out. The pack tracks a delivery budget separately from the source
selection budget: source tokens estimate the underlying records that were
scanned or selected, while delivery tokens estimate the locator-only handoff
that is actually given to another agent.

For a copy-paste operator guide that explains when to use the browser path,
CLI preflight, pinned artifact path, and Codex/Cursor/Claude Code setup
previews, read `docs/usage/local-agent-handoff.md`.

In the browser, use **Build context pack** as the primary local handoff flow.
The source-family checkboxes default to Codex so cross-harness project files are
not scanned unless you select them.
The result can be copied to the clipboard or downloaded as Markdown from the
client. After a pack is built, the Context Pack, Fabric Map, and Agents & Tools
screens share a current-handoff status card; its **Test local handoff** command
copies the read-only Codex preflight below so you can run it in a terminal. It
still performs no server, home config, network, model, adapter, or
external-write side effects from the browser. The browser path does not write
files on the server; use the explicit CLI write mode below when you want a
checked workspace file.

The page also reads existing pinned handoff status through
`GET /api/context/pack/registry/status?workspaceId=ws_local`. This status card
is read-only: it shows whether the local registry/current pointer is verified,
stale, tampered, or missing, and it only offers the MCP use-plan read command
when the current pinned entry verifies. Unsafe persisted source locators in a
hand-edited registry are redacted before CLI, API, or MCP status output and move
the pinned entry back to review.

The result starts with a **Use this pack** brief before the raw Markdown:
changed-file coverage, affected symbols, required local reads, hash proof,
graph hints, source selection reduction, and the exact read-only commands to
reproduce the report. It contains locators, hashes, counts, statuses, and
fingerprints only; it does not include raw source bodies, diff hunks, markdown
bodies, local absolute paths, model calls, network calls, graph databases, or
adapters. The proof commands intentionally include the visible objective and
step arguments because they are runnable local CLI commands.

CLI dry run:

```bash
npm run oaf -- context pack \
  --from codex \
  --root . \
  --objective "Prepare handoff" \
  --step "select next agent context" \
  --target codex \
  --include-file CONTEXT.md \
  --changed apps/web/app.js \
  --dry-run \
  --format markdown
```

Codex handoff preflight:

```bash
oaf context handoff \
  --read-only \
  --from codex \
  --root . \
  --objective "Prepare handoff" \
  --step "select next agent context" \
  --target codex \
  --changed apps/web/app.js \
  --format json
```

This report combines the launch prompt, required local reads, schema-validated
use plan, read-only MCP context-pack readback, and dry-run setup preview. It
does not write context-pack files, mutate harness config, expose MCP tools,
call models, use network access, or enable adapters.

Add `--memory-config oaf.memory.json` only for explicit local memory source
preflight. The report returns proposal/quarantine counts, warning codes, and a
dry-run command; it does not write proposal Markdown, activate memory, or include
memory/source text.

Pinned local handoff receive:

```bash
npm run oaf -- context pack \
  --from codex \
  --root . \
  --objective "Prepare handoff" \
  --step "select next agent context" \
  --target codex \
  --write \
  --pin \
  --out context-packs/CONTEXT_PACK.md \
  --format json

npm run oaf -- context receive \
  --read-only \
  --root . \
  --target codex \
  --format json
```

`context receive` consumes only the pinned `context-packs/current.json`,
registry, and schema-validated use-plan. It returns `ready`, `review`, or
`blocked` with a compact `receiverPacket`, required read locators, content
hashes, MCP read-only resource proof, zero-tool proof, and harness status. It
rejects rebuild inputs such as `--objective`, `--step`, `--from`, `--changed`,
and `--include-file`, and it does not accept write, pin, home, config, or stdio
overrides. Direct `--context-pack-use context-packs/*.use.json` MCP reads are
rejected before resource exposure when the use-plan contains unsafe local paths,
provider URLs, session/token markers, or secret-like strings.

Impact brief:

```bash
oaf measure context-pack \
  --read-only \
  --from codex \
  --root . \
  --objective "Prepare handoff" \
  --step "impact brief" \
  --target codex \
  --changed apps/web/app.js \
  --format json
```

This report includes aggregate changed-source byte/token counts and an
avoidance ratio for raw changed-file bodies that stayed out of the handoff. The
counts are local estimates for proof and comparison, not provider billing-token
or production latency claims. Use `--format summary` instead of `--format json`
when you want the same validated report rendered as a compact terminal brief.

Explicit local write:

```bash
npm run oaf -- context pack \
  --from codex \
  --root . \
  --objective "Prepare handoff" \
  --step "select next agent context" \
  --target codex \
  --write \
  --out context-packs/CONTEXT_PACK.md \
  --format json
```

This does not import harness chat history, create active memory, call a model,
persist a graph database, enable external adapters, or enable external writes.
Selected files are proposal-only `user-selected://` locators and must stay under
the workspace root.

Generated context-pack artifacts are ignored by default through
`context-packs/` in `.gitignore` because they can contain visible objective and
step text. Use `git add -f context-packs/...` only when you intentionally want
to share a reviewed local handoff artifact.

## Read-only MCP resources

Local harnesses can inspect sanitized OAF state through read-only MCP resources:

```bash
npm run oaf -- mcp resources --read-only --format json
npm run oaf -- mcp resources --read-only \
  --uri oaf://workspace/ws_local/context/latest \
  --format json
npm run oaf -- mcp resources --read-only \
  --uri oaf://workspace/ws_local/handoff/latest \
  --format json
npm run oaf -- mcp resources --read-only \
  --context-pack \
  --objective "Continue safely" \
  --step "handoff current context" \
  --target codex \
  --changed apps/cli/oaf.mjs \
  --uri oaf://workspace/ws_local/context-pack/current \
  --format json
npm run oaf -- mcp smoke context-pack --read-only \
  --objective "Continue safely" \
  --step "handoff current context" \
  --target codex \
  --changed apps/cli/oaf.mjs \
  --format json
```

For MCP-compatible stdio clients, pipe JSON-RPC messages into the local
composition. The optional context-pack resource is summary-only: it includes
locators, fingerprints, counts, omissions, and changed-file impact, but not raw
objective text, raw step text, source bodies, markdown bodies, credentials, or
local absolute paths. The smoke command invokes that same stdio path and reports
observed local duration, response size, resource size, selected/candidate
source units, and delivered-handoff units for the single run; it is not a
production latency benchmark.

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"resources/list"}' | \
  oaf mcp resources --read-only --stdio
```

The resources expose status, latest context manifest, latest run, memory
proposal, and handoff/artifact summaries. They return counts, IDs, hashes,
reason codes, timestamps, and explicit safeguards only. They do not start a
network listener, expose write tools, mutate canonical state, create active
memory, write source snapshots, call models, perform external egress, enable
external adapters, or include raw prompts, context bodies, model results,
credentials, provider URLs, absolute local paths, or hidden reasoning.

## Harness setup planner

Use the harness setup planner when you want to see how a local MCP-compatible
client would connect to OAF's read-only resource bridge:

```bash
npm run oaf -- harness setup status \
  --client codex \
  --dry-run \
  --format json

npm run oaf -- harness setup plan \
  --client cursor \
  --server oaf \
  --dry-run \
  --format json
```

For a removable preview:

```bash
npm run oaf -- harness setup uninstall \
  --client cursor \
  --server oaf \
  --dry-run \
  --format json
```

The planner reads only the selected home config, reports `home://` locators,
and emits a redacted operation summary. It does not write `.codex`,
`.cursor`, or other home-directory config files, does not install packages,
does not call models, does not make network calls, and does not enable external
adapters or external writes. Malformed configs fail closed without printing the
raw config body.

Install and uninstall mean preview plus manual copy or removal; OAF does not
mutate home configuration.

The browser shell exposes the same plan-only flow under
<http://127.0.0.1:4310/agents-tools>. That API accepts only the workspace and a
known harness client; it does not accept arbitrary home paths, config paths,
server names, commands, args, or write flags.

## Source graph preview

Use the native JS/TS source graph preview when you need a quick local map of
symbols, calls, references, and likely diff impact without creating memory or a
persisted index:

```bash
npm run oaf -- context graph preview \
  --root . \
  --query "approve token reset" \
  --trace runAuthWorkflow \
  --changed src/auth.ts \
  --dry-run \
  --format json
```

The preview is read-only. It returns safe locators, fingerprints, bounded search
results, optional call traces, optional diff-impact summaries, and explicit
safeguards. It does not read raw source slices, write files, call models, enable
external adapters, perform network access, or require a graph database. The
default file ceiling is 256 KiB for static JS/TS files; callers may lower it for
stricter scans or raise it only up to the 1 MiB hard validation ceiling.
Over-limit files remain explicit changed-locator reads with hash proof when
safely readable, but their symbol impact is not overclaimed.

## Durable workflow smoke

The explicit native durable workflow baseline uses local SQLite only:

```bash
npm run workflow:durable:smoke
OAF_WORKFLOW_DATA_DIR=.local npm run workflow:worker
npm run workflow:inspect -- --workspace ws_local --run run_durable_smoke
```

The durable provider stores `.local/workflows.sqlite` when configured to use
the approved local default. It does not require Docker, Temporal, PostgreSQL,
network access, model downloads, external adapters, or external writes.

## Bounded tool smoke

The native brokered tool baseline uses reviewed checksum-pinned local manifests:

```bash
npm run tool:bounded:smoke
```

It exercises workspace-relative read/write brokers and idempotent local write
reconciliation. It does not run shell commands, download tools, browse, publish,
reach public internet hosts, enable external adapters, or enable external
writes.

## Environment

Copying `.env.example` to `.env` is handled by `npm run bootstrap`. Local files are ignored by Git. Never commit real secrets.

## Optional infrastructure

```bash
docker compose --profile postgres up -d
docker compose --profile ollama up -d
docker compose --profile observability up -d
```

These profiles are scaffolding. Pin image digests and review licenses before release.

## Before a pull request

```bash
npm run check
npm test
npm run eval
npm run manifest
```

Update documentation and `PROJECT_STATUS.json` only when implementation evidence changed.
