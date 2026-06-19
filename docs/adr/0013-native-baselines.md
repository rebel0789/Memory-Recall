# ADR 0013 — Every critical capability has a native baseline

- Status: Accepted
- Date: 2026-06-19

## Context

A local-first platform cannot require optional third-party adapters to complete its primary workflow. Adapters can disappear, change license, fail health checks, or become incompatible. Users also need an offline conformance environment for development and evaluation.

## Decision

Every critical port must have a minimal native implementation that is:

- local-only by default;
- dependency-light or dependency-free;
- deterministic where practical;
- covered by the same conformance suite as external providers;
- explicitly limited rather than presented as production-equivalent.

Initial native baselines are:

- SQLite + FTS5 memory provider;
- content-addressed filesystem artifact provider;
- embedded bounded workflow runtime;
- deterministic model provider;
- optional loopback-only Ollama provider;
- local file-backed event projection;
- native Context Compiler and policy evaluator.

The local workstation can run without an account, API key, paid service, or external adapter.

## Consequences

The native baseline guarantees a usable and testable product. Team-scale implementations may replace individual providers behind the same interfaces without changing workflows or Agent Packs.
