# Storage Architecture

## Canonical store

The target canonical database is PostgreSQL. The bootstrap uses a file-backed conformance store so contract development and CI work offline.

PostgreSQL owns workspaces, workflows, runs, steps, events, context requests and manifests, records and edges, memories, evidence metadata, approvals, policies, evaluations, and adapter metadata.

## Repository layer

`packages/storage/src/postgres-repositories.mjs` implements the first PostgreSQL repository layer for the migration-owned runtime tables that are needed by current task flow: workspaces, workflow versions, runs, events, and context manifests.

The repositories accept an injected PostgreSQL-compatible client with `query(text, values)` and do not add a runtime dependency or change offline bootstrap composition. Event appends run in a transaction, lock the scoped run row, require the next contiguous sequence, and read events with mandatory `workspace_id` and `run_id` filters.

The file-backed state store and native SQLite/artifact providers remain the local conformance baselines. OAF-008 adds native local identity as a separate provider and adds PostgreSQL identity tables for deployments that use the migration runner.

## Migration subsystem

`packages/storage/src/postgres-migrations.mjs` provides explicit PostgreSQL migration discovery, planning, status, and application functions for the `deploy/postgres/migrations` directory. Application startup does not run migrations automatically.

Migration filenames must match `NNN_description.sql`. Discovery reads only the supplied directory, sorts by numeric version, ignores hidden files, rejects malformed visible filenames, rejects duplicate versions, and rejects symlinks that resolve outside the migration directory. Checksums are SHA-256 hashes generated with `node:crypto`.

### Ledger schema

Applied migrations are recorded in `oaf_schema_migrations`:

```sql
CREATE TABLE IF NOT EXISTS oaf_schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  duration_ms bigint NOT NULL
);
```

Status and planning compare the current file checksum with the ledger. An unchanged ledger row is `applied`; a missing ledger row is `pending`; a changed applied migration is `checksum_mismatch`. Checksum mismatches fail closed and are never treated as pending. The runner does not rewrite ledger history.

### Locking and transactions

`applyMigrations` accepts an injected PostgreSQL-compatible pool, client factory, or dedicated client. For pools, it acquires one connection for the whole migration session and uses a PostgreSQL advisory lock for the complete session. It does not use `pool.query` for the session lock.

Each migration runs as one transaction:

```text
BEGIN
<migration SQL as one query>
INSERT INTO oaf_schema_migrations (...)
COMMIT
```

On failure, the runner issues `ROLLBACK`, records no success ledger row for the failed migration, stops later migrations, releases the advisory lock in `finally`, and releases the dedicated connection. SQL is not split on semicolons. Destructive down migrations are unsupported.

Migrations must be transaction-compatible. PostgreSQL operations that cannot run inside a transaction, such as `CREATE INDEX CONCURRENTLY`, need a future reviewed migration mode and must not be added to this subsystem silently.

### Local commands

The local commands require an explicit URL and never infer a production database:

```bash
OAF_POSTGRES_URL=postgres://user:password@127.0.0.1:5432/oaf npm run db:status
OAF_POSTGRES_URL=postgres://user:password@127.0.0.1:5432/oaf npm run db:migrate
```

`db:status` is read-only and does not create the ledger. `db:migrate` creates the ledger when needed and applies pending migrations. Command output redacts credentials.

### Integration and recovery test

The real PostgreSQL recovery test is opt-in and requires an explicit pgvector-capable test database. It resets only OAF-owned tables and only when the reset flag is present:

```bash
OAF_POSTGRES_TEST_URL=postgres://user:password@127.0.0.1:5432/oaf_test \
OAF_POSTGRES_TEST_RESET=true \
npm run db:test:postgres
```

The test verifies clean application of `deploy/postgres/migrations/001_init.sql` and `002_identity.sql`, idempotent second run, rollback of a deliberately failing migration, successful corrected migration, concurrent runner locking, and OAF-004 repository event append behavior after migration.

## Identity storage

The native local identity provider stores `.local/identity/identity.json` with private directory and file permissions, atomic temporary-file plus rename writes, and no remote fallback. It persists users, workspace memberships, sessions, API token metadata, and security audit events.

Password credentials are versioned scrypt strings. Raw passwords, raw session tokens, raw CSRF tokens, and raw API tokens are never written. Sessions and API tokens store hashes only; public API responses expose safe summaries and token metadata, never credential material.

PostgreSQL migration `002_identity.sql` adds `identity_users`, `identity_workspace_memberships`, `identity_sessions`, `identity_api_tokens`, and `security_audit_events`. The migration is additive and does not modify `001_init.sql`.

### Backup and restore

Backups must record the application version and every row in `oaf_schema_migrations` with checksums. Restore rehearsals should verify migration checksums before application startup, validate workspace counts and event sequence integrity, verify artifact hashes, and run read-only representative queries with external writes disabled.

## Derived indexes

- full-text indexes support lexical candidate generation;
- pgvector supports semantic candidates;
- edge tables support graph relationships;
- materialized or application projections support dashboards.

Derived indexes can be rebuilt and never become the sole copy of canonical provenance.

## Artifact bodies

Source snapshots and large artifacts use the native filesystem artifact provider as the local conformance baseline. It stores immutable raw bytes separately from logical records:

```text
.local/artifacts/
  workspaces/
    <workspace-id>/
      objects/sha256/<prefix>/<hash>
      records/artifacts/<record-id>.json
      records/snapshots/<record-id>.json
      tombstones/<record-id>.json
      exports/
```

The object hash is the lowercase SHA-256 of the exact raw bytes supplied by the caller. The provider accepts only bounded `string`, `Buffer`, and `Uint8Array` bodies and does not parse, render, execute, or transform content. Filenames, source URLs, and caller metadata are display/provenance fields only and never influence storage paths.

Logical artifact records and source-snapshot records carry workspace ID, content hash, byte size, media type, data class, retention, provenance, and bounded metadata. Changing body bytes or provenance creates a new logical record. Multiple active records in one workspace may reference the same object, and deleting one record does not remove shared object bytes.

Source snapshots represent collected material and collection provenance only. They default to `trust: untrusted-external`, reject URL userinfo and secret-like provenance, and do not store inferred hooks, summaries, classifications, model conclusions, or memory decisions. Observation normalization and inference remain evidence-layer work.

Retention is explicit. The supported modes are `workspace-default`, `retain`, `expire-at`, and `legal-hold`. `expire-at` requires an ISO timestamp and is applied only by an explicit retention operation; reads never delete expired records. Legal hold blocks deletion and retention purge.

Deletion is explicit, workspace-scoped, idempotent, and auditable through tombstones. Object bytes are physically removed only when no active logical record in the workspace references the content hash.

Integrity verification checks record shape, workspace scope, hash algorithm, record/object hash agreement, raw body SHA-256, byte size, unexpected bodies, missing bodies, malformed metadata, and tombstone consistency. It reports findings and does not auto-repair.

### Artifact protocol schemas

OAF-006 adds strict protocol schemas and compatibility fixtures for:

- `packages/protocol/schemas/artifact-record.schema.json`
- `packages/protocol/schemas/source-snapshot.schema.json`
- `packages/protocol/schemas/stored-object-descriptor.schema.json`
- `packages/protocol/schemas/retention-policy.schema.json`
- `packages/protocol/schemas/deletion-receipt.schema.json`
- `packages/protocol/schemas/artifact-export-manifest.schema.json`
- `packages/protocol/schemas/integrity-verification-result.schema.json`

Raw artifact bodies are never embedded in JSON schemas or export manifests.

## Transaction boundaries

A domain transition appends its canonical event and updates required projections atomically where possible. External side effects use an outbox or durable activity plus idempotency and reconciliation.

## Portability

Workspace export includes versioned JSONL events, normalized records, manifests, workflow definitions, policies, metadata, and referenced artifacts. Provider IDs remain metadata.

The native artifact export is a deterministic directory bundle rather than a zip or tar dependency. It writes a manifest, logical records, and deduplicated object bytes with relative paths only. Deleted records are excluded by default; tombstones require an explicit option. Exports include schema versions, hashes, sizes, and a manifest fingerprint over canonical manifest content.
