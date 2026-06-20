# OAF-015 bounded tool execution implementation note

## Current behavior

`packages/tool-registry/src/index.mjs` is a small manifest-backed registry. It
stores an in-memory `toolId -> { manifest, handler }` map, builds an OAF-009
policy request, calls `createPolicyService().evaluate()`, and directly invokes
the registered handler when policy allows.

The current manifest shape is the legacy v1 shape in
`packages/protocol/schemas/tool-manifest.schema.json`: top-level tool ID, name,
version, risk class, permissions, allowed roles, input/output schemas, timeout,
output limit, and approval metadata. Current committed manifests under
`tools/manifests/` do not have explicit reviewed handler bindings or stable
operation maps.

OAF-009 policy integration already exists in `packages/policy`. The policy
engine owns role/action permissions, tool capability intersections,
filesystem/network/secret/data-class/sandbox/budget checks, approval binding,
idempotency requirements, and the external-write kill switch. OAF-015 must keep
that package as the source of truth and must not add a second role map inside
the tool executor.

## Trust defects to remove

The existing `ToolRegistry.invoke()` accepts caller-supplied `role` and then
constructs an `owner` membership internally. That lets an invocation caller
manufacture authority that should have been resolved by OAF-008 and evaluated
by OAF-009. OAF-015 must require a trusted invocation context containing the
authenticated principal, current membership, API-token restrictions where
applicable, trusted agent role, workspace, run, step, environment, and timestamp.
Request fields such as `role`, `isOwner`, `policyOutcome`,
`externalWritesEnabled`, `allowedPaths`, `allowedDomains`, `secretValues`,
`sandboxProfile`, or `approvalValid` must not widen authority.

There is no reviewed manifest catalog today. Any code path can call `register`
with a manifest object and handler. OAF-015 must add a checksum-pinned catalog,
strict JSON parsing, strict schema validation, symlink and traversal rejection,
bounded manifest/catalog bytes, duplicate rejection, disabled-entry handling,
and no dynamic install/import/fetch behavior.

There is no grant lifecycle today. A policy allow immediately invokes a handler.
OAF-015 must mint an opaque one-use process-local grant after policy allows,
store only the SHA-256 secret hash, bind the grant to the exact operation,
consume it atomically, expire/revoke it deterministically, and keep raw tokens
out of events, logs, errors, snapshots, and durable workflow state.

There is no executor-owned validation or deadline today. OAF-015 must validate
input before policy/handler execution, validate output before success, enforce
input/output/time bounds, propagate cancellation to brokers and handlers, ignore
late results, and fail with stable safe error codes.

There are no filesystem, egress, secret, or sandbox execution brokers today.
OAF-015 must broker workspace-relative filesystem operations, loopback-only HTTP
when explicitly allowed, and secret references independently of policy. The
native baseline supports reviewed built-in handlers only; arbitrary shell,
arbitrary process execution, downloaded code, dynamic module paths, and public
internet access remain unavailable.

## OAF-014 reuse

Writes must reuse OAF-014 durable idempotent effects. The executor will require
an effect boundary for reversible or consequential writes. In a durable
workflow handler this is the OAF-014 `effect()` helper. Same idempotency key and
same operation fingerprint reuse the committed result; same key with a
different fingerprint fails closed. Grants remain short-lived and non-durable:
after a process restart or durable retry, policy must be evaluated again and a
fresh process-local grant issued. Idempotency survives through the OAF-014
effect record, not through grant reuse.

## Compatibility

Existing policy and workflow tests must remain green. Existing registry exports
may remain as wrappers, but compatibility must not preserve caller-supplied
authority. The embedded workflow provider remains the default baseline, the
durable SQLite provider remains explicit, external adapters remain disabled,
external writes remain disabled, and no generic tool-execution HTTP endpoint is
added.
