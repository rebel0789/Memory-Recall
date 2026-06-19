# Build Order and Acceptance Gates

`planning/backlog.json` contains issue-sized task details. This document explains milestone intent. Complete tasks in dependency order and keep the offline bootstrap green.

## Milestone 0 — Freeze contracts — complete in 0.2.0-dev

**OAF-001:** completed — clean checkout, CI, demo, local safety, and handoff verification.  
**OAF-002:** completed — provider-neutral protocol, dependency-free schema checks, and compatibility fixtures.  
**OAF-003:** completed — application ports, provider envelopes, native smoke conformance, and external adapter expectation fixtures.

Gate: no provider payload appears in domain contracts; older v1 fixtures remain readable.

## Milestone 1 — Canonical local data — next

**OAF-004:** PostgreSQL repositories with mandatory workspace scope and append-only events.  
**OAF-005:** checksummed migration runner, dry run, status, interruption tests.  
**OAF-006:** local content-addressed artifact/source store and portable object-store port.

Gate: clean database, repeated migrations, isolation, export, retention, and recovery are tested.

## Milestone 2 — Strict API and authority

**OAF-007:** schema validation, request limits, stable errors, correlation IDs.  
**OAF-008:** replaceable local identity and cross-workspace denial.  
**OAF-009:** relationship and contextual policy ports with default deny.

Gate: malformed input fails before domain code; every tool decision is evented.

## Milestone 3 — Context Compiler v1

**OAF-010:** exact, lexical, semantic, graph, temporal, preference, and episode candidate ports.  
**OAF-011:** inspectable fusion, diversity, reserved budgets, deterministic ties, adversarial evals.  
**OAF-012:** persisted assembly and context manifests with comparison.

Gate: required governance failure is explicit, no scope leakage, and selection improves against a fixed baseline.

## Milestone 4 — Runtime

**OAF-013:** deterministic and explicit local model gateway with structured validation.  
**OAF-014:** durable workflow adapter with process-kill recovery and non-repeated effects.  
**OAF-015:** manifest registry, bounded grants, sandbox, timeout, approval, and idempotency.

Gate: no silent cloud call and no consequential tool without approval evidence.

## Milestone 5 — Evidence and memory

**OAF-016:** source snapshots, normalized observations, deduplication, citation graph.  
**OAF-017:** proposals, review, versions, supersession, retention, export, expiry.  
**OAF-018:** context-use and outcome feedback without causal overclaiming.

Gate: unsupported claims fail and model output cannot silently activate memory.

## Milestone 6 — Content Intelligence

**OAF-019:** bounded file, Markdown, JSON, RSS, and Atom ingestion.  
**OAF-020:** patterns, relative performance, saturation, proof-needed, copying risk.  
**OAF-021:** editable approval, local drafting, verification, and outcome recording.

Gate: useful end-to-end workflow with no authenticated social source or external publisher required.

## Milestone 7 — Product interface

**OAF-022:** routed production shell while preserving conformance UI.  
**OAF-023:** Run and Context Inspector.  
**OAF-024:** Memory, Evidence, and Approval views.

Gate: stable URLs, all states, keyboard/mobile/dark/light/reduced-motion, and exact consequential previews.

## Milestone 8 — Observability and evaluation

**OAF-025:** privacy-safe OpenTelemetry-compatible instrumentation.  
**OAF-026:** datasets, experiments, comparisons, regression gates.

Gate: default changes cannot merge without required evaluation evidence.

## Milestone 9 — Ecosystem

**OAF-027:** one pinned, low-risk, read-only adapter.  
**OAF-028:** MCP first; other protocol bridges only through accepted RFCs.

Gate: remote peers never inherit local authority and core runs without adapters.

## Milestone 10 — 1.0

**OAF-029:** backup, restore, upgrade, rollback, diagnostics, incidents.  
**OAF-030:** signed reproducible release, SBOM, provenance, security review, governance, compatibility.

Gate: release checklist and independent reviews complete.
