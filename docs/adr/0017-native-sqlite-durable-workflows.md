# ADR 0017 — Native SQLite durable workflow baseline

- Status: Accepted
- Date: 2026-06-20

## Context

Open Agent Fabric needs long workflow state to survive local process death
without requiring a hosted service, third-party workflow server, network, or
runtime dependency. The embedded workflow runtime is useful for fast tests and
demo compatibility, but JavaScript closures, pending promises, and captured
process memory cannot be crash-resumed.

## Decision

OAF-014 adds `provider:native:workflow:durable-sqlite`, a dependency-free local
reference runtime behind `WorkflowRuntimePort` version `1.1.0`.

The provider uses Node 22 `node:sqlite`, a private `.local/workflows.sqlite`
data path by default, WAL for file-backed databases, an internal schema version,
foreign keys, bounded JSON fields, integrity checks, worker leases, durable
timers, durable retries, approval waits, cancellation, idempotency records, and
canonical history events.

Workflow definitions are immutable and serializable. Handler code is registered
locally by stable handler ID and semantic version. Runs store the exact
definition fingerprint used at start and fail closed if the registered
definition changes for the same workflow ID/version.

Activity execution is at least once. Non-repetition depends on target-level
idempotency at the effect boundary. The provider does not claim exactly-once
delivery to arbitrary external systems. External writes remain disabled.

The embedded runtime remains available and does not claim process recovery.
Temporal remains a future optional adapter behind the same port; it is not a
bootstrap dependency.

## Consequences

The offline bootstrap now has a crash-durable local workflow baseline for
conformance and recovery tests. Team-scale engines may implement the same port
later without changing canonical workflow definitions, run IDs, event history,
or Agent Packs.
