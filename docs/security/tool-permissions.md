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

1. Tool and operation exist.
2. Actor and workspace are authorized.
3. Input schema and size pass.
4. Data class is allowed.
5. Files, network, secrets, cost, and sandbox fit policy.
6. Approval is valid for the exact operation hash.
7. Grant is minted and expires quickly.
8. Tool runs once, output is bounded and sanitized.
9. Result is reconciled and evented.

Skill text and model output can request a tool; neither grants it.
