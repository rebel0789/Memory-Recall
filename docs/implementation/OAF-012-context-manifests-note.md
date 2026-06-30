# OAF-012 Context Manifests Implementation Note

## Current State

OAF-011 made context selection deterministic, budgeted, and traceable, but the
compiled model input still lived only in memory or in run events. OAF-012 adds a
durable composition layer around the existing selector without changing the
pure `compileContext(request, records)` API.

## Implemented Change

`compileAndPersistContext(...)` compiles context, assembles selected records into
reserved sections, validates fingerprints and token accounting, appends the
manifest through a provider-neutral repository, verifies the stored copy, emits
a safe `context.manifest.persisted` event, and only then allows downstream model
work.

The reserved assembly order is:

```text
governance, negative, decisions, preferences, procedures, evidence, episodes,
artifacts, examples, other, workingState
```

Empty sections are omitted. Selected text is preserved exactly inside the
assembly for reproducible model input. Excluded records are stored without raw
text in durable manifests.

## Storage

OAF-012 adds `ContextManifestRepositoryPort` and a native local provider at
`providers/native/context-manifest-local`. The provider stores immutable JSON
under:

```text
.local/context-manifests/workspaces/<workspace-id>/manifests/<manifest-id>.json
```

Append is idempotent for the same ID and fingerprint and fails closed with
`manifest_identity_conflict` for the same ID and a different fingerprint.
Tampering is detected by verification and not repaired.

The PostgreSQL context manifest repository now exposes the same append/get/list,
verify, and compare behavior using the existing `context_manifests` table. No
migration file was changed.

## Boundaries

This task does not enable external adapters, external writes, hosted models,
network connectors, embeddings, vector databases, graph databases, browser
automation, publishing, or unrelated UI work.
