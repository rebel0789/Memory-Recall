# Native Provider Baselines

Native providers make the local product useful without optional integrations. They are conformance implementations, not excuses to leak storage or model details into domain contracts.

## Provider set

| Provider | Default | Purpose |
| --- | --- | --- |
| `native.memory.sqlite` | on | Versioned local memory with FTS5 candidate search, generated filesystem reports, and proposal queue |
| `native.artifacts.filesystem` | on | Workspace-scoped content-addressed artifacts and source snapshots |
| `native.workflow.embedded` | on | Bounded local execution and checkpoints |
| `native.workflow.durable-sqlite` | off | Local SQLite crash recovery baseline |
| `native.model.deterministic` | on | Reproducible tests and offline demo |
| `native.identity.local` | on | Local users, sessions, API tokens, memberships, and security audit |
| `native.policy.deterministic` | on | Contextual policy decisions for resources, tools, data classes, approvals, and budgets |
| `native.context-candidate.exact` | on | Workspace-scoped exact candidate lookup by canonical record ID |
| `native.context-candidate.lexical` | on | Deterministic lexical candidate lookup over safe record fields |
| `native.context-manifest.local` | on | Workspace-scoped immutable local context manifest persistence |
| `native.model.ollama` | off | Explicit loopback local-model generation |
| `native.tool.brokered-local` | on | Reviewed checksum-pinned local tool execution behind brokers |

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

The provider stores data under `.local/artifacts/workspaces/<workspace-id>/...`, never deduplicates across workspaces, rejects symlink escapes and traversal, and keeps external adapters disabled. It does not store large bodies in PostgreSQL. OAF-029 adds verified import of provider-owned workspace exports for local restore rehearsal; cloud sync, publishing, authentication, and background retention workers remain unsupported.

## SQLite memory provider

The native SQLite memory provider implements `MemoryBackendPort` for local
workspace-scoped memory. It stores full memory-core lifecycle and review
metadata, including decisions, reasons, evidence IDs, conflicts, verified and
activated actors, and lifecycle events. Search uses SQLite FTS5 over local
records; it is not vector retrieval, graph search, hosted memory, or external
sync.

OAF-031 adds a filesystem UX layer over canonical memory. `oaf memory profile`
generates `memory/profile.md` from accepted active OAF memory only.
`oaf memory proposals` generates `memory/proposals/*.md` reports for pending
and quarantined records. These files are generated reports: editing them does
not create or update canonical memory. `memoryPaths` config entries are
explicit workspace-relative proposal sources only, bounded to local files and
redacted before report output. Proposal reports also include source diagnostics
for selected memory files: role, hash, line count, byte size, age, stale-source
warnings, and markdown memory-index cap warnings. These diagnostics are
review-only signals; they do not create active memory or change retrieval
policy by themselves.

`oaf context profile` builds a read-only compressed profile for context
selection: static long-term memory plus dynamic recent memory are converted into
bounded synthetic Context Compiler records, then selected under the normal token
budget. Its `contextBudget` reports estimated delivery tokens, accepted-history
tokens available, history tokens avoided, and the measured reduction ratio. It
does not replay raw history, call a model, open the network, or create memory.

`oaf memory sgrep` is a local source-grounded memory search command, not a
replacement for shell `grep`. It returns lifecycle state, evidence IDs, and
context-manifest reason codes when an explicit manifest is supplied. The
provider also includes a SQLite proposal queue with idempotent fingerprints,
leases, retry-to-pending, and poison/error records for local reconciliation.
Temporal facts are stored in separate `fact`, `entity`, `edge`, and `episode`
tables with `validFrom`, `validUntil`, `supersededBy`, and episode provenance.
`oaf memory fact add/get/history` writes and reads that temporal surface through
the native provider. Fact writes require an applied proposal queue record; a
contradicting fact supersedes the old row by closing its valid window and never
hard-deletes it. The temporal fact table has its own FTS5 index.
`oaf memory search/path/explain` adds the first local hybrid retrieval surface:
FTS5 matches seed the result set, entity edges add graph-neighbor facts,
temporal ranking prefers recent valid facts, and scoped digests provide a compact
graphify-style handoff summary. Semantic sqlite-vec ranking is reported as
skipped when no local embedder is available; no network or model API is called.
Offline fact extraction is ADD-only and deterministic: safe `subject predicate
object` triples from an episode enqueue reviewable proposals with provenance and
entity links. Extraction does not write active facts; the existing proposal queue
must still be approved before a temporal fact can be added.
No network calls, model calls, external writes, Supermemory sync, FUSE/NFS
mounts, API-key storage, or active-memory creation from ordinary file edits are
enabled.

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

## Deterministic policy provider

The native policy provider implements `PolicyEvaluatorPort` version `1.0.0`.
It runs in process, uses the committed policy registry, and has no network,
model, dynamic execution, or runtime download path. Its health and capabilities
output expose the policy version and deterministic registry fingerprint.

The provider evaluates trusted requests produced after OAF-008 authentication
and current membership resolution. It returns structured allow/deny decisions,
bounded stable reason codes, safe effective capability scopes, and audit-ready
metadata. It denies unknown or malformed dimensions by default and keeps
external writes disabled.

## Context candidate-source providers

The native exact, lexical, and AST-code providers implement
`CandidateSourcePort` version `1.0.0`. Exact and lexical remain the
conformance baselines for OAF-010 candidate generation. None of these sources
is a storage engine or final selector.

The exact source performs workspace-scoped batch lookup through an injected
provider-neutral record reader. It deduplicates requested IDs, preserves request
order as local rank, records an exact-match source hit, supports cancellation,
and does not fuzzy match, substring search, scan all workspace records, write
state, or reveal inaccessible exact IDs.

The lexical source reuses deterministic term-overlap behavior over safe fields:
objective, step, required entities, record text, tags, relations, and safe title
fields. It sorts by local score then canonical record ID. It does not use regex
queries, embeddings, vector databases, graph databases, stemming, model
expansion, global reranking, recency, authority, diversity, token budgeting,
network access, external adapters, credentials, private paths, cookies, auth
headers, or database configuration.

Both sources require contextual policy allow decisions before invocation and
candidate-level policy allow decisions before output. Secret data is denied for
model-context candidate generation by default.

The AST-code source is a dependency-free static JS/TS chunker and symbol index
for workspace files. It records parser version, workspace locator, byte and
line ranges, scope chain, symbol/import/export metadata, sibling locators,
signature hashes, exact reconstruction hashes, parse-error state, file
outlines, repository outlines, and content-hash journals without returning raw
source bodies or absolute local paths. It supports read-only definition,
reference, import, export, caller, callee, file-outline, and repository-outline
queries over the derived index. It is not a full semantic parser, language
server, graph index, executor, or Tree-sitter runtime.

OAF-011 preserves exact and lexical providers as conformance baselines. Hybrid
fusion, global reranking, diversity, category caps, and token budgeting live in
`packages/context-compiler/src/index.mjs`, not in candidate-source providers.
Vector, graph, temporal, preference, and episode source kinds remain declared
but unavailable until later tasks add explicit providers.

## Context manifest provider

The native context manifest provider implements
`ContextManifestRepositoryPort` version `1.0.0`. It persists immutable context
manifests under `.local/context-manifests`, scoped by workspace and run.

It supports append, get, list-by-run, compare, and verify. Appending the same
manifest ID and fingerprint is idempotent; appending the same ID with a
different fingerprint fails closed. Verification detects tampering and does not
repair or overwrite files. The provider has no network access, no external
writes, and no remote fallback.

## Durable workflow provider

The native durable workflow provider implements `WorkflowRuntimePort` version
`1.1.0` as `provider:native:workflow:durable-sqlite`. It is disabled by default
and explicitly selectable for local recovery tests and smoke commands.

It stores its internal runtime database under `.local/workflows.sqlite` by
default, enables SQLite WAL for file-backed databases, checks integrity in
health, and keeps provider-specific SQLite objects behind the port. The provider
supports serializable definitions, stable handler references, run listing,
approval resolution, bounded worker ticks, worker loops with `AbortSignal`,
history retrieval, clean close, timers, retries, cancellation, worker leases,
and idempotent effect records.

The runtime guarantees durable orchestration and at-least-once activity
invocation. It reuses committed idempotent effect records after retry or
restart, but it does not claim exactly-once delivery to arbitrary external
systems. External writes remain disabled.

## Local model providers

The deterministic and Ollama native model providers implement
`ModelGatewayPort` version `1.0.0`.

The deterministic provider is enabled by default and runs in process. It is a
structured-output conformance baseline for the demo workflow and tests. It has
no network, tool-use, hosted fallback, or general reasoning claim.

The Ollama provider is disabled by default. It requires an explicit loopback
HTTP base URL and model name, propagates timeout and cancellation to `fetch`,
and reports unavailable or degraded health locally. It does not download
models, call hosted APIs, expose provider URLs in events, or silently switch
providers.

Both providers are invoked through `packages/model-gateway`, which validates
structured output, allows at most one repair call to the same provider/model,
and records only safe model metadata.

## Brokered local tool provider

The native brokered tool provider implements `ToolExecutionPort` version
`1.0.0` as `provider:native:tool:brokered-local`. It loads only reviewed
checksum-pinned manifests from `tools/catalog.json` and dispatches to reviewed
in-process handler bindings.

Execution is local and brokered, not arbitrary-code sandboxing. The provider
does not run shell commands, download tools, browse, publish, call public
internet hosts, enable external adapters, or persist raw grant tokens. It
independently brokers workspace-relative filesystem access, exact loopback
egress, and declared secret references. Reversible writes use the durable
idempotent effect boundary so retries or restarts can reconcile without blindly
repeating an ambiguous write.
