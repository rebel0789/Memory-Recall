# Protocol Schemas

`packages/protocol/schemas` contains dependency-free JSON Schema contracts used
by the bootstrap validator and compatibility fixtures.

## Policy schemas

OAF-009 adds internal policy schemas for principals, resources, environment
context, capability requests, effective capability, approval context, policy
evaluation requests, policy decisions, policy audit events, registry
descriptors, and reason codes.

These schemas document trusted service-to-service contracts. They do not expose
a public policy-evaluation route. Control API handlers build policy inputs after
authentication and current membership resolution; clients cannot supply roles,
environment authority, registry rules, or executable policy text.

## Context candidate-source schemas

OAF-010 adds candidate-source contracts for provider-neutral context candidate
generation: source kind, descriptor, request, source plan, context candidate,
source hit, source report, generation result, failure code, and identity
conflict. These schemas describe trusted internal composition between the
Context Compiler and enabled native sources. They do not expose a generic public
search route, provider selection, external adapters, vector stores, embeddings,
graph stores, browser automation, or outbound network access.

## Context selection schemas

OAF-011 adds internal selection contracts for source-fusion config, feature
weights, category budgets, stable selection and exclusion reason codes,
selection decisions, coverage summaries, sufficiency results, score
breakdowns, the versioned selection policy, and the safe selection result.

These schemas are internal service contracts for deterministic selection. They
do not expose client-supplied weights, model reranking, embeddings, vector or
graph stores, external search, publishing, browser automation, external
adapters, or raw context bodies.

## Context manifest schema

OAF-012 evolves `context-manifest.schema.json` additively for durable assembly
and persistence. Existing selected/excluded manifest fields remain compatible.
Durable manifests may also include manifest fingerprints, assembly sections,
selection summaries, candidate-generation summaries, token accounting, and
verification metadata. The durable assembly preserves selected text exactly for
model input while omitted excluded text prevents storing inaccessible or unsafe
candidate bodies.

OAF-031 extends the durable manifest contract with explicit assembly
representation tiers, `etag`, `deltaFrom`, representation hashes, original-token
counts, selected-token ratios, assembled-token ratios, and token budget reports.
These fields are additive so older OAF-012 durable assemblies remain schema
valid. New manifests redact unsafe local source paths before persistence. The
fields remain local compiler metadata; they do not add model calls, memory
imports, external adapters, or external writes.

## Memory filesystem UX schemas

OAF-031 adds `memory-profile-report.schema.json`,
`memory-proposals-report.schema.json`, `memory-sgrep-report.schema.json`,
`memory-workspace-config.schema.json`, and
`memory-proposal-queue-record.schema.json`. These contracts describe generated
workspace-local memory reports, explicit proposal-source configuration, local
source-grounded search output, and SQLite proposal queue reconciliation.

The reports are not canonical memory authority. They require zero network
calls, zero model calls, zero external writes, zero active-memory creation, and
disabled external adapters. `memoryPaths` entries are workspace-relative
proposal sources only. Queue records use safe workspace locators, idempotent
fingerprints, leases, retries, and poison/error states.

## Durable workflow schemas

OAF-014 adds strict internal schemas for durable workflow definitions, durable
run records, approval resolution signals, workflow history responses, and
durable runtime error codes. These schemas allow serializable handler
references, bounded state, UTC timestamps, fingerprints, and canonical events.
They do not allow function source, module paths, SQL, credentials, cookies,
authorization headers, provider-specific SQLite objects, raw prompts, local
paths, or hidden reasoning.

## Bounded tool schemas

OAF-015 adds internal contracts for reviewed checksum-pinned tool catalogs,
reviewed tool manifests, handler descriptors, sandbox profile names,
invocation requests, process-local grant records, invocation results,
reconciliation metadata, safe tool event payloads, and stable tool error codes.

These schemas describe trusted service-to-service tool execution. Clients
cannot supply roles, policy outcomes, secret values, raw grant tokens, handler
code, provider URLs, local filesystem paths, downloaded tools, shell commands,
browser automation, or external-write authority.

## MCP bridge schema

OAF-028 adds `mcp-bridge-request.schema.json` for the local MCP bridge request
surface. It validates JSON-RPC-shaped method names and rejects top-level
authority injection. Runtime bridge code still performs trusted-context, grant,
replay, disconnect, and private-payload checks because remote protocol payloads
are not authority.

## Benchmark truth-floor schemas

The benchmark truth-floor schemas add additive v1 contracts for deterministic
gold-evidence datasets, phase artifacts, and comparison reports. Reports are
strict metric and fingerprint records: they may include evidence IDs and safe
workspace locators, but not raw prompts, context bodies, model outputs,
credentials, provider URLs, local paths, hidden reasoning, active-memory writes,
source snapshots, external writes, or enabled external adapters.

## AST code chunk schema

`ast-code-chunk.schema.json` describes dependency-free static JavaScript and
TypeScript chunks for the native AST code candidate source. It records parser
version, workspace locator, line and byte ranges, scope chain, symbol,
import/export metadata, sibling locators, signature hashes, parse error state,
and source hashes. `source-symbol-index.schema.json` describes the derived
read-only JS/TS symbol index for definitions, references, imports, exports,
callers, callees, and file locators. `source-graph.schema.json` describes the
native derived source graph built from that index: files, chunks, symbols,
modules, contains, defined-in, import, export, reference, and call edges, plus
safe summaries. `source-graph-preview.schema.json` describes the bounded
read-only CLI/API preview envelope for graph summary, search, optional trace,
optional diff impact, and explicit no-write/no-model safeguards. These schemas
intentionally exclude raw source bodies, absolute paths, executable parser
output, embeddings, graph-database records, and provider configuration. The
native provider's root-bounded exact-slice helper is for internal reconstruction
tests only; it is not a protocol output or a candidate-source query result.
