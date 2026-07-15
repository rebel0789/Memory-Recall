# Architecture Overview

## Product boundary
![Memory Recall architecture](../assets/open-agent-fabric-architecture.png)

_Conceptual target architecture. Boxes are responsibilities, not a requirement to deploy each as a separate service._


Memory Recall is the local-first repository memory and context tool for coding agents. Its current product path is Recall Map, governed memory, read-only MCP, and inspectable handoffs. The wider reference bootstrap also contains workspaces, runs, workflows, events, context manifests, evidence, approvals, policies, artifacts, hooks, evaluations, and integration metadata.

It does not own foundation models, third-party agent framework internals, social platforms, or upstream hosted products. Those can enter through replaceable integrations, but they do not own Memory Recall's canonical state, authority, or user workflow.

## Logical architecture

```mermaid
flowchart TB
  subgraph Interfaces
    Web[Web console]
    CLI[CLI]
    IDE[IDE / protocol clients]
  end
  subgraph Control[Control plane]
    API[Control API]
    Registry[Agent / skill / tool registry]
    Approval[Approval and policy]
  end
  subgraph Runtime[Execution plane]
    Workflow[Durable workflow runtime]
    Runner[Bounded agent runner]
    Context[Context Compiler]
    Gateway[Model gateway]
    Tools[Tool gateway]
  end
  subgraph Data[Canonical data]
    Events[(Event ledger)]
    State[(PostgreSQL + pgvector)]
    Objects[(Artifact and source snapshots)]
  end
  subgraph Optional[Disabled adapters]
    Memory[Memory backends]
    Research[Research connectors]
    Design[Design tools]
    Publish[Publishers]
    Collaborate[Collaboration]
  end
  Web --> API
  CLI --> API
  IDE --> API
  API --> Workflow
  API --> Registry
  Workflow --> Runner
  Runner --> Context
  Runner --> Gateway
  Runner --> Tools
  Approval --> Tools
  Context --> State
  Workflow --> Events
  Tools --> Events
  API --> State
  API --> Objects
  Tools --> Optional
```

## Core planes

### Control plane

Defines identities, workspaces, workflows, agents, tools, skills, budgets, policies, approvals, schedules, versions, hooks, and integration configuration. It contains deterministic authority.

### Execution plane

Runs bounded steps. A durable workflow engine handles retries, timers, suspension, recovery, and compensation. Agent runners handle model interaction inside one step. Models do not control authorization or workflow durability.

### Context plane

Normalizes candidates and compiles the smallest sufficient context. It resolves scope, lifecycle, time, supersession, conflicts, relevance, diversity, risk, and budget before a model call.

### Data plane

Stores canonical events and state. Source snapshots and large artifacts use object storage. Semantic indexes and knowledge graphs are derived indexes, not authoritative records.

### Experience plane

Presents outcome first, explanation second, trace third. Chat is optional. Runs, sources, memories, artifacts, approvals, and manifests have stable URLs.

## Bootstrap versus target

The current bootstrap uses Node's built-in HTTP server, file-backed local state, deterministic generation, synthetic observations, an in-process workflow runner, and a dependency-free static interface.

The target production profile strengthens these behind contracts with PostgreSQL, durable workflows, explicit local model servers, content-addressed object storage, authentication, OpenTelemetry, hooks, and optional integrations. The bootstrap remains a fast offline conformance environment.

## Deployment profiles

**Offline bootstrap:** no network, model, or database. Used for onboarding, CI, deterministic tests, and protocol work.

**Local workstation:** control API, web app, PostgreSQL/pgvector, local object storage, local model server, and optional durable runtime.

**Team self-hosted:** adds authentication, encrypted secrets, backups, sandbox workers, policy service, tracing, and isolated adapter workers.

## Reliability model

Each step has typed input and output, context policy, allowed tools, side-effect class, timeout, retry policy, validation, approval requirement, and compensation behavior. External writes use idempotency keys. Events support replay and audit, but migrations still govern projection compatibility.

## Native reliability layer

The core always has a local baseline. `providers/native/` implements the default local experience first. Optional integrations can implement the same ports later for compatibility or scale, but workflows and UI code still depend on internal contracts rather than provider details.

The local baseline includes SQLite/FTS5 memory, content-addressed filesystem artifacts, an embedded workflow runtime, deterministic generation behind the local model gateway, and an explicit loopback-only Ollama option. Read `native-providers.md` and `model-gateway.md` for limitations.

## Portable execution contract

Agent Packs package model capability requirements, context and memory policy, requested tools, skills, workflows, permissions, UI surfaces, and evaluation references. They contain no credentials and grant no authority. Runtime policy resolves and authorizes a pack before activation.

## Reliability loop

```text
record → inspect → replay without effects → compare → propose change
       → run in shadow → evaluate → approve → version → monitor → roll back
```

The flight recorder is a canonical event and artifact view, not hidden chain-of-thought. It records selected context, actions, policy decisions, evidence, versions, and outcomes required for reproducibility.
