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

Do not pass passwords on the command line. The HTTP API exposes only `GET /api/auth/bootstrap-status`; first-owner creation is CLI-only. The local identity store is `.local/identity/identity.json`.

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
