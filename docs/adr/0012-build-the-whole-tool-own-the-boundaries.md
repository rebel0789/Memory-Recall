# ADR 0012 — Build the whole tool, own the boundaries

- Status: Accepted
- Date: 2026-06-19
- Decision owners: Memory Recall maintainers

## Context

The agent ecosystem already contains useful memory systems, research collectors, graph builders, collaboration tools, design studios, publishers, model panels, and workflow frameworks. Copying all of them into one repository would create incompatible dependencies, duplicated state, licensing risk, and a maintenance burden that would prevent the platform from evolving.

At the same time, making Memory Recall only a collection of wrappers would leave it without a durable product advantage. Memory Recall is the tool users run: the local runtime, context system, memory lifecycle, code/repository intelligence, tool boundary, evidence trail, hooks, UI, CLI, and release surface. Optional integrations may help, but they do not define the product.

## Decision

Memory Recall will use four implementation strategies.

1. **Build natively** when a capability defines the product, runtime quality, context quality, or reliability boundary.
2. **Use hooks as accelerators** when a client can steer discovery, compact noisy tool output, or route retrieval earlier without granting authority.
3. **Adopt as infrastructure** when a mature general-purpose component already solves the problem.
4. **Integrate externally only through reviewed contracts** when a project is valuable but not canonical.
5. **Fork only through an approved RFC** when upstream cannot support a critical requirement and the project can maintain the fork indefinitely.

The native core owns:

- canonical IDs and domain schemas;
- the event ledger and run flight recorder;
- Context Compiler selection and manifests;
- source graph, retrieval, compaction, and code intelligence needed for the default local experience;
- temporal memory lifecycle and write governance;
- deterministic permissions, approvals, and capability grants;
- project-scoped hooks that improve performance or context routing without changing authority;
- replay, shadow evaluation, and learning proposals;
- portable Agent Packs;
- the operator, builder, and auditor product model;
- conformance tests for all providers.

External projects enter through narrow contracts only when they add optional compatibility or scale. They never become the canonical identity, event, policy, memory, context, code-intelligence, hook, or artifact model.

Hooks are inputs to OAF, not control planes. A hook can suggest a graph query before raw file reads, compact an oversized tool result, or attach a retrieval reference. A hook cannot grant filesystem, network, tool, secret, policy, approval, publishing, or permanent-memory authority.

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
- The platform differentiates on the full local tool experience: context, code intelligence, memory, reliability, evidence, governance, hooks, and safe learning.

### Negative

- External integration requires explicit normalization and conformance work.
- Some upstream features will not be exposed until mapped to stable contracts.
- Maintaining native baselines adds engineering effort.

## Rejected alternatives

- **Merge every repository into a monorepo:** rejected for dependency, licensing, and upgrade risk.
- **Make one memory or workflow product canonical:** rejected because provider internals would leak into public state.
- **Build every capability from scratch:** rejected because it wastes effort on mature infrastructure and commodity integrations.
- **Ship only a proxy around other tools:** rejected because OAF must own the runtime, context, memory, evidence, hook, and approval experience end to end.
