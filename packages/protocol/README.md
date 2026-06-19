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
