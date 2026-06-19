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

## Durable target

An adapter must prove process-kill recovery, durable timers, approval waits, bounded retries, cancellation, non-repetition of consequential effects, and mapping to canonical OAF events.

## Replay

Replay can re-evaluate deterministic projections or execute explicitly replay-safe steps. It must never blindly repeat external writes. Every workflow version remains addressable after a new version ships.
