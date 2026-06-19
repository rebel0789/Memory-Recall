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
  P-->>R: bounded grant
  R->>T: execute with idempotency key
  T-->>R: reconciled result
  R->>E: tool.completed
```

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
