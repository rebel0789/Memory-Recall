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
