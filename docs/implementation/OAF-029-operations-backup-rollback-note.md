# OAF-029 Operations, Backup, Upgrade, and Rollback

## Scope

OAF-029 adds a local operations reference path for backup, restore, deployment
profile verification, diagnostics redaction, and rollback planning. It keeps the
standard bootstrap deterministic and offline.

Implemented:

- `packages/operations` backup manifest creation, verification, restore,
  deployment-profile checks, diagnostics redaction, and rollback plans;
- verified import of filesystem artifact workspace exports;
- `npm run ops:smoke`;
- `native:smoke` backup/restore coverage;
- focused tests for clean restore, corruption failure, version compatibility,
  external-write denial, deployment profile checks, diagnostics redaction, and
  rollback plan shape.

Not implemented:

- production SSO or MFA;
- hosted secret management;
- container image digest pinning;
- production database dump orchestration;
- cloud backup storage;
- managed retention workers;
- external adapters, external writes, publishing, browser automation, or public
  internet connectors.

## Trust Boundary

Backups contain workspace-private state and artifact metadata. Backup manifests
record relative paths and checksums only. Diagnostics redact credential-shaped
keys, PostgreSQL passwords, raw bodies, prompts, outputs, provider URLs, local
paths, SQL, cookies, tokens, authorization values, and hidden reasoning.

Restore verifies the backup before writing state. Artifact restore imports only
provider-owned exports, rejects symlinks and escaping paths, verifies object
hashes and byte sizes, preserves workspace scope, and runs artifact integrity
checks after import.

## Verification

- `node --test tests/operations.test.mjs`
- `npm run ops:smoke`
- `npm run native:smoke`
- `npm run ci`
