# OAF-014 Durable Workflow Implementation Note

## Scope

OAF-014 adds a native SQLite durable workflow provider as the local crash-recovery
baseline behind `WorkflowRuntimePort`. The existing embedded runtime remains the
fast in-process compatibility provider.

## Current Embedded Behavior

`providers/native/workflow-embedded` stores run/event checkpoints in
`.local/state.json` while JavaScript step closures run in the current process.
It supports start, inspect, and cancellation through in-memory
`AbortController` instances. It cannot resume arbitrary closures after process
death because the function, captured variables, pending promises, and host
process state are not serializable workflow history.

## Current Port Shape

`WorkflowRuntimePort` currently requires `health`, `start`, `get`, and
`cancel`. OAF-014 extends that contract additively with durable capabilities for
registration, bounded listing, approval signals, worker ticks/loops, canonical
history, and clean close. Durable-only behavior is capability-gated; embedded
does not claim process recovery.

## Durable Definition Boundary

Crash recovery requires immutable serializable workflow definitions and stable
handler IDs. A durable run stores the exact definition fingerprint used at start.
After restart, the provider can compare the registered workflow fingerprint with
the persisted run before executing the next transition. It never persists
function source, closures, modules, downloaded code, raw prompts, local paths, or
credentials.

## Native SQLite Baseline

SQLite via Node 22 `node:sqlite` is the native local baseline because it is
dependency-free, file-backed, transactional, portable on developer machines, and
already used for native memory conformance. The provider uses WAL for file
databases, private local paths, integrity checks, and a versioned internal
schema. It is a reference local runtime, not a replacement claim for team-scale
engines.

## Temporal Boundary

Temporal remains a future optional adapter behind the same port. Adding a
Temporal SDK/server would violate the dependency-free bootstrap and would move
OAF-014 away from the native conformance baseline requested by the task.

## Responsibilities

The durable orchestrator owns run state, leases, timers, retries, approval
waits, cancellation, idempotency records, and canonical event ordering. Step
handlers are trusted local composition-time functions registered by stable ID and
version. Handlers receive bounded input, prior outputs, idempotency keys, an
abort signal, a trusted clock, a safe event emitter, and an effect helper. They
do not receive raw SQLite access.

## Delivery Semantics

Activity invocation is at least once. Non-repetition depends on target-level
idempotency keyed by workspace, workflow, run, step, handler, and operation
fingerprint. The native provider can reuse a committed idempotent effect result
after process death, but it does not claim exactly-once behavior for arbitrary
external systems. External writes remain disabled.

## Compatibility

The embedded provider and the current demo remain runnable on the existing
in-process path. OAF-014 adds explicit durable mode, CLI smoke commands, tests,
protocol schemas, and documentation without silently switching all callers.
