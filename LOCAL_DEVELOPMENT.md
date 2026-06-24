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

## Context pack handoff

The Context Pack page at <http://127.0.0.1:4310/context-pack> builds a
schema-validated handoff for the next local agent. It selects safe workspace
locators from documented Codex, Claude Code, and Cursor project files, adds
bounded native JS/TS source graph hints, optionally includes explicit
user-selected relative files, then renders Markdown instructions without
embedding raw source bodies or code slices.

CLI dry run:

```bash
npm run oaf -- context pack \
  --from all \
  --root . \
  --objective "Prepare handoff" \
  --step "select next agent context" \
  --target codex \
  --include-file docs/context.md \
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
