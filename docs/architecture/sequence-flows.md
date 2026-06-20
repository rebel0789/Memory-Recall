# Core Sequence Flows

## Model-backed workflow step

```mermaid
sequenceDiagram
  participant W as Workflow runtime
  participant P as Policy
  participant C as Context Compiler
  participant M as Model gateway
  participant E as Event ledger
  W->>E: step.started
  W->>P: authorize context and model capabilities
  P-->>W: allow with bounded policy version
  W->>C: compile(context request)
  C-->>W: context manifest
  W->>E: context.compiled
  W->>M: generate(schema, manifest reference, assembled context)
  M-->>W: validated output and usage
  W->>E: step.completed or step.failed
```

## Consequential tool call

```mermaid
sequenceDiagram
  participant A as Agent step
  participant R as Tool registry
  participant P as Policy
  participant U as User
  participant T as Tool worker
  participant E as Event ledger
  A->>R: request exact operation
  R->>P: actor, scope, risk, permissions, destination
  P-->>R: approval required
  R->>E: approval.requested
  R-->>U: exact preview and expiry
  U-->>R: approve once
  R->>P: validate approval and operation hash
  P-->>R: allow with effective capability
  R->>R: mint one-use exact-operation grant
  R->>T: execute via filesystem/egress/secret brokers
  T-->>R: reconciled result
  R->>E: tool.completed
```

The broker never receives caller-supplied authority fields. For local writes,
the tool handler uses the OAF-014 durable idempotent effect boundary before the
result is treated as reconciled.

## Memory proposal

```mermaid
sequenceDiagram
  participant S as Agent or user
  participant G as Memory write gate
  participant H as Human reviewer
  participant D as Memory store
  participant E as Event ledger
  S->>G: propose record with source
  G->>G: classify, deduplicate, scan, conflict, retention
  alt requires confirmation
    G-->>H: proposed diff and evidence
    H-->>G: approve, edit, or reject
  end
  G->>D: append version and lifecycle
  G->>E: memory.activated or memory.rejected
```

## Context failure behavior

If any candidate source fails, the manifest records the source failure. The compiler must not silently widen allowed scope, drop governance records, or substitute an unapproved source. Required governance that cannot fit the budget is a hard, explainable failure.

## Durable workflow recovery

```mermaid
sequenceDiagram
  participant W1 as Worker process A
  participant DB as SQLite workflow store
  participant T as Idempotent target
  participant W2 as Worker process B
  W1->>DB: claim run lease and append step.started
  W1->>T: execute with stable idempotency key
  T-->>DB: commit effect reference
  W1--xW1: process killed before step.completed
  W2->>DB: open store, integrity check, reclaim expired lease
  W2->>DB: append run.resumed
  W2->>DB: reuse committed effect, append step.completed
  W2->>DB: continue timers, approvals, retries, or completion
```

The recovery path does not restore JavaScript closures. It resumes from the
persisted definition, step state, attempts, timers, approvals, leases, events,
and idempotency records.
