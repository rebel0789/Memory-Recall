# ADR 0014 — Portable Agent Packs are a first-class artifact

- Status: Accepted
- Date: 2026-06-19

## Context

Agent behavior is usually scattered across prompts, framework code, environment variables, tool configuration, memory settings, and undocumented assumptions. This makes agents difficult to inspect, reproduce, share, or migrate.

## Decision

Open Agent Fabric defines a provider-neutral **Agent Pack** that versions the reproducible contract for an agent or agent team.

An Agent Pack declares:

- identity and version;
- runtime and model capability requirements;
- context and memory policies;
- tools, skills, and permissions;
- workflow references;
- user interface surfaces;
- evaluation suites and fixtures;
- provenance and compatibility metadata.

Agent Packs contain configuration and references, not credentials or hidden provider state. They are validated, fingerprinted, and exportable.

## Consequences

The same agent definition can move between local models, model providers, memory backends, and compatible runtimes. A pack alone does not grant authority; runtime policy still evaluates every capability.
