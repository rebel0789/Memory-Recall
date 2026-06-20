# Domain Model

## Aggregate boundaries

### Workspace

Owns data residency, policy, members, model configuration, adapters, retention, and export. Every domain query and event is workspace-scoped.

### User, membership, session, and API token

A user is an authenticated local principal. Public user summaries expose ID, username, display name, status, and timestamps only. Password credentials are provider-private and never part of the domain DTO.

A workspace membership links a user to one workspace with role `owner`, `builder`, `operator`, or `auditor`. Authorization decisions are deterministic role/action checks plus current user, membership, token scope, token workspace, expiration, and revocation state.

A browser session is an opaque server-side credential. Public session responses include the safe user summary, active memberships, and effective actions only. API tokens are separate bearer credentials scoped to workspaces and actions. The raw API token is returned only once when created; list responses expose metadata only.

### Workflow and run

A workflow is an immutable versioned definition. A run references one workflow version and owns step attempts, events, manifests, artifacts, approvals, and outcomes.

Durable workflow definitions are serializable and fingerprinted. Executable
steps reference local trusted handlers by stable ID and version. Durable runs
store the exact workflow fingerprint, input fingerprint, state, step attempts,
timers, approvals, leases, idempotency records, and canonical events needed to
resume after process death. Handler source, closures, modules, local paths,
credentials, and raw model prompts are not domain state.

### Context request and manifest

A request states objective, step, actor, required entities and records, token budget, allowed data classes, and time. A manifest records candidates considered, selections, exclusions, conflicts, assembly order, token accounting, and compiler version.

A context candidate is a canonical record plus provider-neutral candidate
metadata. It carries workspace ID, data class, scope, trust class, lifecycle
status, token estimate, confidence, authority, timestamps, content hash or
fingerprint, provenance references, and one or more source hits. A source hit
records source ID, source kind, source version, retrieval method, local
rank/score, bounded reasons, a SHA-256 query fingerprint over non-secret query
material, an access-decision reference, and retrieval time.

Candidate sources are discovery ports. They do not grant authority, perform
final selection, or change canonical record identity. The Context Compiler
selection policy owns weighted source fusion, feature scoring, diversity,
category caps, token budgeting, sufficiency checks, conflict surfacing, and
selected/excluded manifest output.

A context selection result is an internal trace separate from the public
manifest. It records policy version and fingerprint, candidate-generation
fingerprint, selected and excluded decisions, coverage, sufficiency, conflicts,
safe score breakdowns, bounded warnings, and deterministic result fingerprint.
It does not include raw record text, prompts, secrets, local paths, SQL, or
hidden model reasoning.

OAF-012 persists durable manifests before model calls. A durable manifest adds
manifest and assembly fingerprints, reserved assembly sections, final selected
record order, safe source-warning and failure summaries, token accounting, and
the compiler version. Selected text is present only as assembled model input.
Excluded records carry IDs, categories, scores, tokens, and reason codes without
raw excluded text.

### Evidence

A source snapshot is an immutable body and metadata record. An observation is normalized from a snapshot. An inference is a model-generated interpretation linked to evidence IDs. These never share one ambiguous field.

Source snapshot records use the `src_` prefix, carry collection provenance (`collector`, `retrievalMethod`, `sourceLocator`, `capturedAt`), and default to `trust: untrusted-external`. They are not allowed to contain summaries, classifications, hooks, memory decisions, or model conclusions. Those fields are created later as observations, inferences, claims, or memory proposals.

The native evidence service constructs an immutable citation graph from source snapshots, observations, and claims. The graph records deterministic deduplication groups, claim-to-observation citation edges, staleness classifications, and conflict findings. These outputs do not overwrite source snapshots or observations and do not create memory records.

Artifact records use the `art_` prefix. Both artifact records and source snapshots reference immutable stored objects by `hashAlgorithm: sha256`, `contentHash`, and `byteSize`; the stored object itself has no provenance or authority. Deleting a logical record creates an audit tombstone and does not imply that shared object bytes are removable.

### Memory

A memory record has kind, scope, lifecycle, confidence, provenance, valid time, transaction time, retention, and optional `supersedes`. Models emit proposals; deterministic policy and review activate records.

### Capability and grant

A tool manifest declares operations and permissions. A grant is short-lived, actor-bound, run-bound, operation-bound, and narrower than the manifest. A tool result cannot broaden its own grant.

OAF-009 policy decisions evaluate the exact tool operation before a provider is
invoked. Effective capability is the intersection of actor role, current
membership, action policy, trusted tool manifest, requested operation, workflow
or run grant, environment policy, data class, sandbox profile, budgets, approval
context, idempotency, and global kill switches. Requests wider than the manifest
deny the whole operation rather than silently dropping unsafe scope.

OAF-015 separates reviewed manifests, policy decisions, and grants. A reviewed
manifest is loaded only from a checksum-pinned catalog. The grant record stores
safe binding metadata only; the raw token is returned to the broker in memory,
consumed once, and not persisted or logged. Filesystem, loopback egress, and
secret-reference access are represented as independent broker capabilities, not
ambient process authority.

### Approval

An approval references an exact operation preview, destination, risk, actor, expiry, idempotency key, and policy version. Editing the action invalidates the approval.

The exact operation fingerprint is a SHA-256 digest over stable fields including
actor, workspace, action, resource, tool operation, requested scopes,
side-effect class, data class, payload fingerprint, and idempotency key. Approval
does not replace sandbox enforcement and cannot override the external-write
kill switch.

## Identity prefixes

```text
ws_     workspace
usr_    user
wsm_    workspace membership
ses_    session
tok_    API token
aud_    security audit event
wf_     workflow version
run_    run
step_   step attempt
ctx_    context manifest
src_    source snapshot
obs_    observation
inf_    inference
mem_    memory record
art_    artifact
app_    approval
grant_  capability grant
evt_    event
eval_   evaluation result
```

Provider identifiers are metadata, never canonical identity.

## Temporal model

Records carry:

- `observedAt`: when a source event was observed;
- `validFrom` and `validTo`: when a fact is considered true;
- `createdAt` and `updatedAt`: system transaction time;
- `collectedAt`: when an external item entered the system;
- `metricAt`: when a metric measurement applies.

Do not collapse these timestamps.

## Lifecycle rules

```text
observed → proposed → verified → active
                         ↘ rejected
active → superseded | retracted | expired
```

History is immutable. Projections may hide inactive records by default, but audit and version chains remain available.
