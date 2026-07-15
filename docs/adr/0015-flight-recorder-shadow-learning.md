# ADR 0015 — Replay, shadow mode, and learning proposals

- Status: Accepted
- Date: 2026-06-19

## Context

Agents fail in ways that are difficult to reproduce. Systems also commonly let agents alter prompts or memory without controlled evaluation, turning mistakes into persistent behavior.

## Decision

Memory Recall treats every run as a flight record composed of versioned events, context manifests, tool decisions, model metadata, artifacts, approvals, evaluations, and outcomes.

The platform supports:

- exact dry replay from recorded inputs;
- replay with an alternate model or context policy;
- shadow execution with all external writes disabled;
- run comparison at claim, context, event, cost, and outcome levels;
- learning proposals expressed as reviewable diffs with evidence, tests, rollback, and affected workflows.

No agent may silently change its own permanent memory policy, prompts, permissions, or skill definitions. It proposes a change; deterministic evaluation and human policy decide whether it becomes active.

## Consequences

Improvements become testable and reversible. Storage requirements increase because run inputs and manifests must be retained according to policy.
