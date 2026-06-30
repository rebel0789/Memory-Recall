# Local Deployment Profiles

## Bootstrap

Node process on loopback, file store, deterministic model. Best for development
and protocol conformance. OAF-029 backup/restore is implemented and tested for
this profile through `npm run ops:smoke`.

## Local native profile

For a single-developer workstation, run:

```bash
npm run local:run
```

This composes `npm run bootstrap` and `npm run native:smoke`. It verifies the
local native provider path without enabling network access, cloud fallback,
external writes, team authentication, or hosted services. The profile covers
local-owner bootstrap, proposal-gated SQLite memory, native retrieval, context
compilation, local artifacts, deterministic model behavior, and native smoke
checks. It is not the team/cloud deployment target.

## Workstation target

- OAF control API and web;
- PostgreSQL with pgvector;
- content-addressed local object directory;
- explicit local model server;
- optional durable runtime;
- optional OpenTelemetry collector.

Use `packages/operations` for local state and artifact backup rehearsal. Use the
database platform's own dump/restore tooling for PostgreSQL data, then verify
OAF migration checksums and representative read-only queries before startup.

## Team target

Adds reverse proxy/TLS, authentication, encrypted secret backend, sandbox workers, isolated adapters, backups, retention, policy service, and monitored telemetry.

Never expose the bootstrap server directly to an untrusted network. Container
examples are development scaffolding until image digests, authentication,
hardening, database backup rehearsal, and upgrade procedures are complete.
