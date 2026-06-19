# ADR 0012 — Build the brain, adapt the organs

- Status: Accepted
- Date: 2026-06-19
- Decision owners: Open Agent Fabric maintainers

## Context

The agent ecosystem already contains useful memory systems, research collectors, graph builders, collaboration tools, design studios, publishers, model panels, and workflow frameworks. Copying all of them into one repository would create incompatible dependencies, duplicated state, licensing risk, and a maintenance burden that would prevent the platform from evolving.

At the same time, making Open Agent Fabric only a collection of wrappers would leave it without a durable product advantage. The platform must own the layer that determines reliability, portability, authority, evidence, and safe improvement.

## Decision

Open Agent Fabric will use four integration strategies.

1. **Build natively** when a capability defines product identity or controls reliability.
2. **Integrate through adapters** when an upstream project is valuable but replaceable.
3. **Adopt as infrastructure** when a mature general-purpose component already solves the problem.
4. **Fork only through an approved RFC** when upstream cannot support a critical requirement and the project can maintain the fork indefinitely.

The native core owns:

- canonical IDs and domain schemas;
- the event ledger and run flight recorder;
- Context Compiler selection and manifests;
- temporal memory lifecycle and write governance;
- deterministic permissions, approvals, and capability grants;
- replay, shadow evaluation, and learning proposals;
- portable Agent Packs;
- the operator, builder, and auditor product model;
- conformance tests for all providers.

External projects enter through narrow provider contracts. They never become the canonical identity, event, policy, memory, or artifact model.

## Dependency rule

```text
core never imports adapters
adapters import core contracts
applications depend on core interfaces
provider selection happens at composition time
```

No workflow imports a third-party SDK directly. It requests a capability from the registry. No UI component calls a provider directly. It calls an application service.

## Fork rule

No fork may enter the critical path without an accepted RFC that records:

- upstream repository and exact commit;
- reason an adapter or upstream contribution is insufficient;
- local patches and maintainer;
- license review;
- security update process;
- reconciliation or exit strategy.

## Consequences

### Positive

- Upstream projects can be upgraded or replaced independently.
- The Apache core remains small and portable.
- Canonical state survives provider changes.
- The platform differentiates on context, reliability, evidence, governance, and safe learning.

### Negative

- Adapter development requires explicit normalization and conformance work.
- Some upstream features will not be exposed until mapped to stable contracts.
- Maintaining native baselines adds engineering effort.

## Rejected alternatives

- **Merge every repository into a monorepo:** rejected for dependency, licensing, and upgrade risk.
- **Make one memory or workflow product canonical:** rejected because provider internals would leak into public state.
- **Build every capability from scratch:** rejected because it wastes effort on mature infrastructure and commodity integrations.
