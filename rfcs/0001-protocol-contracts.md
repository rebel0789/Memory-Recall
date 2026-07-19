# RFC 0001 — Provider-Neutral Protocol Contracts

**Status:** Draft for OAF-002

## Goal

Freeze additive v1 contracts for events, context requests and manifests, memory records, tool/skill/agent/adapter manifests, content observations, workflows, approvals, artifacts, and error envelopes.

OAF-015 extends the v1 protocol additively with reviewed tool catalogs,
reviewed tool manifests, handler descriptors, sandbox profile names, invocation
requests, safe grant records, invocation results, reconciliation metadata, safe
tool event payloads, and stable tool error codes.

OAF-028 extends the v1 protocol additively with a local MCP bridge request
schema and compatibility fixtures. The bridge uses JSON-RPC-shaped MCP methods
for initialization, tool/resource discovery, tool invocation, and resource
reads, but OAF trusted context and server-side exact grants remain outside
caller-supplied protocol payloads.

The Recall Map report schema adds an internal, versioned read-only composition
contract for locator-safe static-source-graph and governed-memory summaries.
It keeps active facts distinct from pending proposals and fingerprints the
stable report payload without treating a provider identity, graph index, or
memory store as canonical protocol identity.

The source-graph and source-graph-preview summaries add optional, additive v1
coverage and architecture-ranking fields. Coverage records only safe workspace
locators, bounded skipped/oversized and excluded-directory samples, unsupported
extension summaries, and an explicit complete/partial state. Unreadable source
files are kept as bounded skipped evidence and force `partial` while readable
files remain available. An unreadable source directory emits a safe
`directory_unreadable` diagnostic and forces `partial` without being relabeled
as a configured directory exclusion. Excluded directories are separate from
skipped files:
declared metadata/dependency/output directories remain visible without alone
changing coverage to partial, while source-relevant exclusions force `partial`;
after a file cap, bounded directory discovery preserves that exclusion truth or
records that discovery itself was capped. Preview rankings carry explicit
static reason codes and bounded deprioritized diagnostics; they do not imply
language-server, semantic, model, graph-database, or source-body access.
The preview facade and ranking share the schemas' strict workspace-relative
locator and source-graph label grammars: valid changed-file line spans may be
stripped for impact, while query strings, malformed fragments, private or
absolute paths, raw-source-like text, URI-scheme/path-like values in any fully
decoded workspace-relative segment (for example `workspace://src/file:/...` or
`workspace://src/%66ile%3A/...`), recursively encoded path traversal or
separator values, and sentinel labels are rejected before they can enter a
report. A colon is reserved for the explicit `#Lx-Ly` suffix, not a path token.
Public graph reads project a strict metadata envelope: bounded workspace IDs,
SHA-256 graph and source-index fingerprints, projected diagnostics, and
field-whitelisted nodes and edges. Unsafe supplied graph metadata fails closed
to empty reader results with safe fallback metadata; graph candidate requests
fall back to their configured safe workspace ID. The preview accepts only a
schema-valid complete envelope and otherwise returns its unavailable report.
Colon-bearing source-graph labels are limited to safe `node:` built-in module
names and the fixed `local:absolute-import` placeholder.

Additive v1 coverage can also identify the active ignore policy and report
candidate, represented, and omitted graph counts by node or edge kind. Node and
edge budgets are enforced while the graph is built, with structural and call
edges retained before reference edges. A partial result remains read-only: the
omission fields describe missing representation and never grant access to
ignored files, absolute paths, source bodies, or additional operations.

The code-intelligence graph adds a provider-neutral, bounded contract for the
production native engine. It fixes canonical structural IDs and stable node,
edge, language, resolution, evidence, generation, and freshness vocabularies.
Closed records reject raw source bodies, absolute paths, provider identities,
parser-native IDs, and arbitrary metadata. The graph is derived local state and
does not become canonical memory or approval authority. This schema is additive
within v1; `source-graph.schema.json` remains the JavaScript and TypeScript
compatibility surface until the native migration passes its release gates.

The native engine request and response schemas add the versioned JSON Lines
process contract. Node supplies one bounded `graph.build` request rooted at the
child process working directory, enforces the deadline and optional
cancellation token, and validates both the response envelope and nested graph.
The engine emits protocol frames only on stdout. Failures use stable error
codes with sanitized details; raw errors, source text, absolute paths, provider
objects, filesystem authority, and network authority are not protocol fields.

The code-intelligence capability matrix can record an additive per-capability
applicability value and rationale. Tier 1 semantic auditing requires both
fields. A `not-applicable` row must also use the `not-applicable` benchmark
state and the `unsupported` product state. Applicable rows cannot use that
benchmark state. This keeps language semantics separate from missing fixture or
repository evidence and prevents an unsupported applicable behavior from
becoming green through an empty sample. Older v1 matrix rows without these
optional schema fields remain structurally valid, but they cannot pass the
current Tier 1 semantic audit.

## Requirements

- canonical IDs are independent of providers;
- every workspace-owned object carries workspace scope;
- every event supports correlation and causation;
- temporal and provenance fields are explicit;
- data classification and schema version are explicit;
- unknown major versions fail clearly;
- unknown additive fields survive round trips where practical;
- raw secrets and large source bodies are references, not payload fields.
- raw grant tokens, raw prompts, tool outputs, secret values, provider URLs,
  local paths, and caller-supplied authority fields are not protocol payloads.
- MCP bridge callers cannot supply OAF principal, membership, role, approval,
  grant token, filesystem, network, or external-write authority.
- Recall Map reports carry no source bodies, fact text, proposal payloads,
  absolute paths, provider IDs, model/network calls, graph-database records,
  or mutation authority; their read-only safeguards are strict compatibility
  requirements.

## Open questions for OAF-002

- Exact compatibility policy for optional versus required additive fields.
- Whether event payload schemas share one registry or remain package-local.
- Canonical error code namespaces.
- Serialization requirements for hashes and large integer usage.

## Acceptance

Valid, invalid, and backward-compatibility fixtures pass deterministic tests. No adapter-specific identifier becomes canonical identity.
