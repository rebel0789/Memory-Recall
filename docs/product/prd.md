# Product Requirements Document

## Problem

Agent systems accumulate messages, tool output, summaries, preferences, source material, and model interpretations. As histories grow, agents drift, contradict earlier decisions, retrieve near-misses, repeat side effects, and become difficult to debug. Existing products often couple memory, models, and workflows to one vendor or expose a chat interface without durable product state.

## Opportunity

Build a portable selection and execution substrate. Let users keep canonical context, evidence, workflow history, policies, and evaluations while replacing models and adapters. Make the system useful locally before adding networked services.

## Jobs to be done

1. “Show me what the agent is doing and why it chose this context.”
2. “Resume a long task without repeating an external action.”
3. “Remember stable decisions and preferences without polluting memory.”
4. “Research a topic, preserve evidence, and create original content angles.”
5. “Swap a model, memory store, or connector without losing organizational state.”
6. “Give a coding agent a repository it can evolve safely.”

## v0.1 user journey

A user starts a local Content Intelligence workflow from synthetic or file/RSS evidence. The run normalizes observations, compiles a bounded context, generates three candidates through a deterministic or local model, verifies citations, and presents the outcome, context manifest, event trace, and evidence. No external write is enabled.

## Must-have capabilities

- local workspace and residency visibility;
- versioned workflows and bounded steps;
- append-only events and stable IDs;
- selected/excluded context manifest;
- evidence and inference separation;
- memory proposal gate;
- typed tool permissions and approval model;
- deterministic mock and explicit local model mode;
- accessible outcome/explanation/trace interface;
- repeatable tests and evaluations.

## Product constraints

- no paid service required for the core;
- no hidden cloud dependency;
- no autonomous publishing default;
- no importing all upstream repositories into one process;
- no memory write from raw model output;
- no benchmark or “superintelligence” claims without reproducible evidence.

## Release acceptance

See `docs/implementation/BUILD_ORDER.md` and `docs/testing/quality-gates.md`. `PROJECT_STATUS.json` must match passing evidence.
