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
