# Tool Permissions

## Manifest versus grant

A manifest describes the maximum possible capability. A grant authorizes one actor, run, operation, resource set, and time window. The grant is always narrower.

## Declared dimensions

- allowed roles and actions;
- filesystem read/write roots;
- network domains, methods, and ports;
- secret references;
- data classes;
- process and sandbox profile;
- time, memory, output, and cost limits;
- side-effect class;
- approval and idempotency rules.

## Side-effect classes

**Read-only:** does not alter canonical or external state. Reads can still leak data and require scope and egress policy.

**Reversible write:** modifies local state with a tested rollback.

**Consequential write:** public, destructive, financial, administrative, permission-changing, or difficult to undo. Requires exact preview, approval, idempotency, reconciliation, and eventing.

## Decision order

1. HTTP and runtime boundaries validate shape and size.
2. OAF-008 authentication resolves the principal and current membership.
3. The OAF-009 contextual policy service evaluates actor, workspace, action,
   resource, tool, data class, side effects, filesystem, network, secrets,
   sandbox, budgets, approval, idempotency, and global kill switches.
4. A denial stops before the provider or domain side effect is invoked.
5. Input schema and size pass.
6. Approval is valid for the exact operation fingerprint when required.
7. Grant is minted and expires quickly.
8. Tool runs once, output is bounded and sanitized.
9. Result is reconciled and evented.

Skill text and model output can request a tool; neither grants it.

## OAF-009 contextual policy

`packages/policy` is the single source of truth for route authorization and tool
capability checks. The committed registry has a semantic version and
deterministic SHA-256 fingerprint. Runtime code never downloads policy, accepts
model-authored policy, or silently ignores unknown registry fields.

Filesystem scopes are policy identifiers, not exposed OS paths. Read and write
are separate, traversal-like segments and control characters are rejected, and
prefix confusion such as `workspace:project-evil` versus `workspace:project` is
denied.

Network policy matches protocol, exact host, port, method, consequence, and
loopback/external locality. Suffix confusion such as
`example.com.evil.test` is denied. External writes remain globally disabled for
OAF-009 even with an approval.

Secret permissions use references such as `secret:x.read`; secret values are
not accepted by policy and are never resolved during evaluation. Public errors
stay sanitized as `forbidden` or `resource_not_found`; internal reason codes are
for tests and safe audit events.
