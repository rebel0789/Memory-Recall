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
locators from documented Codex, Claude Code, and Cursor project files, adds
bounded native JS/TS source graph hints, optionally includes explicit
user-selected relative files, and maps explicitly named changed files to compact
impact hints. It then renders Markdown instructions without embedding raw source
bodies or code slices. The pack also includes omitted context refs so a user can
recover skipped local files by locator when the budget or relevance selector
left them out.

In the browser, use **Build context pack** as the primary local handoff flow.
The result can be copied to the clipboard or downloaded as Markdown from the
client. The browser path does not write files on the server; use the explicit
CLI write mode below when you want a checked workspace file.

CLI dry run:

```bash
npm run oaf -- context pack \
  --from all \
  --root . \
  --objective "Prepare handoff" \
  --step "select next agent context" \
  --target codex \
  --include-file docs/context.md \
  --changed apps/web/app.js \
  --dry-run \
  --format markdown
```

Explicit local write:

```bash
npm run oaf -- context pack \
  --from all \
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
```

For MCP-compatible stdio clients, pipe JSON-RPC messages into the local
composition:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"resources/list"}' | \
  npm --silent run oaf -- mcp resources --read-only --stdio
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
external adapters, perform network access, or require a graph database.

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
