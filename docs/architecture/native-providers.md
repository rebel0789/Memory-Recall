# Native Provider Baselines

Native providers make the local product useful without optional integrations. They are conformance implementations, not excuses to leak storage or model details into domain contracts.

## Provider set

| Provider | Default | Purpose |
| --- | --- | --- |
| `native.memory.sqlite` | on | Versioned local memory with FTS5 candidate search |
| `native.artifacts.filesystem` | on | Workspace-scoped content-addressed artifacts and source snapshots |
| `native.workflow.embedded` | on | Bounded local execution and checkpoints |
| `native.model.deterministic` | on | Reproducible tests and offline demo |
| `native.identity.local` | on | Local users, sessions, API tokens, memberships, and security audit |
| `native.model.ollama` | off | Explicit loopback local-model generation |

## Rules

- A provider may import core contracts; core packages may not import a provider.
- Provider-specific identifiers stay inside provider metadata.
- Every provider declares health, capabilities, limits, and data paths.
- No provider silently changes from local to remote.
- Native providers pass the same behavioral conformance tests expected of external adapters.
- Provider limitations must appear in `PROJECT_STATUS.json` and health responses.

## Composition

The application composition root chooses providers from configuration. Workflows and UI code depend only on ports. Switching from SQLite memory to Mem0, or from the embedded runner to Temporal, does not change canonical records or Agent Packs.

## Filesystem artifact provider

The native artifact provider implements `ArtifactStorePort` version `1.1.0`. It is a local conformance baseline for:

- immutable raw-byte SHA-256 objects;
- immutable artifact and source-snapshot records;
- source-snapshot provenance with default `untrusted-external` trust;
- explicit retention planning and application;
- idempotent tombstoned deletion;
- integrity verification without auto-repair;
- deterministic portable directory export.

The provider stores data under `.local/artifacts/workspaces/<workspace-id>/...`, never deduplicates across workspaces, rejects symlink escapes and traversal, and keeps external adapters disabled. It does not store large bodies in PostgreSQL and does not provide restore, cloud sync, publishing, authentication, or background retention workers.

## Local identity provider

The native identity provider implements `IdentityStorePort` version `1.0.0` for local-first authentication and workspace authorization:

- first-owner bootstrap through `npm run auth:bootstrap -- --username owner --display-name "Local Owner" --password-stdin`;
- scrypt password credentials with per-password random salts;
- opaque browser sessions with httpOnly SameSite=Strict cookies;
- CSRF tokens bound to sessions and compared with timing-safe checks;
- hashed API tokens returned raw only at creation time;
- workspace memberships with owner, builder, operator, and auditor roles;
- security audit events without raw secrets, cookies, token values, password credentials, salts, or filesystem paths.

The provider stores `.local/identity/identity.json`, uses private permissions, and has no cloud fallback. It is a bootstrap/local provider, not production SSO, MFA, hosted secret management, or encrypted-at-rest storage.
