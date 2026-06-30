# Workflow Runtime

## Separation of responsibility

Deterministic workflow code controls state transitions, retry policy, timers, approvals, budgets, idempotency, and compensation. Bounded agent steps interpret ambiguity, synthesize evidence, or generate candidates.

## Step contract

```text
id and version
input schema and output schema
context policy
allowed tools and side-effect class
model requirements
budget and timeout
retry and cancellation
validation
approval requirement
idempotency and compensation
```

## Bootstrap runtime

The in-process runner demonstrates bounded attempts, timeout, monotonic events, summaries, and safe failure. It is not crash durable.

## Native durable SQLite runtime

OAF-014 adds `provider:native:workflow:durable-sqlite` as the dependency-free
local crash-recovery baseline. It stores immutable serializable workflow
definitions, runs, step state, attempts, timers, approval waits, idempotency
records, leases, and canonical events in `.local/workflows.sqlite` by default.

Handlers are trusted local functions registered by stable handler ID and
version. Only handler references are persisted. Definitions store a fingerprint
per workflow ID/version, and a restart fails closed if the registered
definition no longer matches the persisted run fingerprint.

The provider supports:

- `queued`, `running`, `waiting_timer`, `waiting_retry`,
  `waiting_approval`, `completed`, `failed`, and `cancelled` run states;
- durable retry backoff with persisted attempts and due time;
- timer waits based on persisted UTC instants;
- approval waits with exact operation fingerprints;
- persisted cancellation and abort delivery to active handlers;
- one active worker lease per run and lease reclaim after process death;
- idempotent effect records keyed by workspace and operation fingerprint;
- canonical history through `run.*`, `step.*`, `timer.*`, and `approval.*`
  events.

Activity invocation is at least once. A committed idempotent effect can be
reused after restart, but the runtime does not claim exactly-once behavior for
arbitrary external systems. Reconciliation remains required for future
non-idempotent external targets.

OAF-015 reuses this effect boundary for brokered local tool writes. A tool
retry or recovered workflow must request a fresh one-use grant, but the local
write effect is keyed by the same idempotency key and operation fingerprint so
the committed effect is reused instead of repeated.

## Durable target

An adapter must prove process-kill recovery, durable timers, approval waits, bounded retries, cancellation, non-repetition of consequential effects, and mapping to canonical OAF events.

## Replay

Replay can re-evaluate deterministic projections or execute explicitly replay-safe steps. It must never blindly repeat external writes. Every workflow version remains addressable after a new version ships.
