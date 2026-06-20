# Execution Queue

The authoritative acceptance criteria live in `docs/implementation/BUILD_ORDER.md`. The machine-readable queue lives in `planning/backlog.json`.

```bash
npm run status
npm run task -- <OAF-ID>
```

## Foundation

- [x] OAF-001 Verify the kit from a clean checkout.
- [x] OAF-002 Ratify protocol RFC and compatibility fixtures.
- [x] OAF-003 Define application ports and conformance tests.

## Canonical data

- [x] OAF-004 Implement PostgreSQL repositories.
- [x] OAF-005 Implement migration runner and recovery tests.
- [x] OAF-006 Complete content-addressed artifact and source snapshots.

## API and authority

- [x] OAF-007 Add strict API boundary validation.
- [x] OAF-008 Implement local identity and workspace authorization.
- [x] OAF-009 Implement authorization and contextual policy ports.

## Context Compiler

- [x] OAF-010 Add candidate-source ports.
- [x] OAF-011 Add hybrid fusion, reranking, diversity, and reserved budgets.
- [x] OAF-012 Persist assembly and context manifests.

## Runtime

- [x] OAF-013 Complete the model-gateway contract and local integration tests.
- [x] OAF-014 Add a durable workflow adapter and crash recovery.
- [x] OAF-015 Implement tool registry, bounded grants, and sandbox execution.

## Evidence and memory

- [x] OAF-016 Implement the evidence service and citation graph.
- [x] OAF-017 Complete native versioned memory and the write gate.
- [x] OAF-018 Add context-use and outcome feedback without causal overclaiming.

## Content Intelligence

- [x] OAF-019 Implement file and RSS ingestion.
- [x] OAF-020 Implement patterns, relative performance, saturation, and copying risk.
- [x] OAF-021 Implement approval, local drafting, and outcome recording.

## Product interface

- [x] OAF-022 Build the production web shell while preserving bootstrap contracts.
- [x] OAF-023 Build Run and Context Inspector views.
- [ ] **OAF-024 Build Memory, Evidence, and Approval views — next.**

## Quality and ecosystem

- [ ] OAF-025 Add OpenTelemetry-compatible instrumentation.
- [ ] OAF-026 Build the evaluation laboratory.
- [ ] OAF-027 Promote one low-risk read-only adapter.
- [ ] OAF-028 Add protocol bridges through accepted RFCs.
- [ ] OAF-029 Complete operations, backup, restore, upgrade, and rollback.
- [ ] OAF-030 Complete 1.0 open-source release readiness.

Never enable external writes before authorization, exact approval, idempotency, reconciliation, and adversarial tests pass.
