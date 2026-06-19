# Local Deployment Profiles

## Bootstrap

Node process on loopback, file store, deterministic model. Best for development and protocol conformance.

## Workstation target

- OAF control API and web;
- PostgreSQL with pgvector;
- content-addressed local object directory;
- explicit local model server;
- optional durable runtime;
- optional OpenTelemetry collector.

## Team target

Adds reverse proxy/TLS, authentication, encrypted secret backend, sandbox workers, isolated adapters, backups, retention, policy service, and monitored telemetry.

Never expose the bootstrap server directly to an untrusted network. Container examples are development scaffolding until image digests, authentication, hardening, and upgrade procedures are complete.
