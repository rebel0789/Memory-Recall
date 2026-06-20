# Backup and Restore

## Implemented reference path

OAF-029 adds a dependency-free recovery path in
`packages/operations/src/index.mjs` and smoke coverage in
`scripts/operations-smoke.mjs`.

The implemented reference backup covers:

- `FileStateStore` state from `.local/state.json`;
- one workspace's content-addressed filesystem artifact export, including
  tombstones;
- PostgreSQL migration status and migration checksums supplied by the migration
  status layer;
- a top-level backup manifest, component SHA-256 hashes, manifest fingerprint,
  and `manifest.json.sha256` sidecar;
- restore rehearsal into isolated state and artifact roots with external writes
  disabled.

Run:

```bash
npm run ops:smoke
```

The smoke creates a local backup, verifies the manifest and component hashes,
restores into fresh directories, validates the restored artifact body, validates
deployment profiles, verifies diagnostics redaction, and proves a corrupt backup
fails closed.

## Bootstrap Profile

Stop the server before copying live state. Prefer the OAF-029 operations backup
helper over manual copying because it validates JSON shape, monotonic event
sequences, component checksums, migration status, artifact export integrity, and
version compatibility before restore.

Manual copying of `.local/state.json` is only a last-resort diagnostic action.
It is not a completed backup until a restore rehearsal passes.

## Workstation Profile

Back up PostgreSQL and content-addressed artifact storage as one consistency set. Record schema version, migration checksums, application version, encryption/key references, and object inventory.

For OAF-029, the PostgreSQL portion is migration-status evidence only. A real
database dump/restore belongs to the deployment's database tooling and must be
rehearsed before production use. Do not claim PostgreSQL backup support from the
OAF-029 manifest alone.

## Restore rehearsal

- restore to an isolated environment;
- verify migration checksums before startup;
- validate workspace counts and event sequences;
- verify artifact hashes;
- run read-only health and representative queries;
- never allow external writes during rehearsal;
- record recovery time and data-loss window.

A backup that has not passed a restore rehearsal is not a completed backup system.

## Corruption and Version Failure

Restore fails before writing state when:

- `manifest.json` is missing or has an unsupported schema;
- `manifest.json.sha256` does not match the manifest bytes;
- the manifest fingerprint is invalid;
- a component checksum differs from the manifest;
- state JSON is malformed or has non-monotonic event sequences;
- migration status reports checksum mismatch or failure;
- artifact object hashes, sizes, or export fingerprints do not match;
- the requested application version is incompatible.

## Retention and Deletion

Backups inherit the data classification and retention obligations of the
workspace they contain. Store backup directories outside runtime data roots,
protect them with operating-system permissions, and delete expired backups only
after an operator confirms legal hold and incident-preservation requirements.
