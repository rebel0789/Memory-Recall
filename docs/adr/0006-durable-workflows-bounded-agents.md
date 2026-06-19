# ADR 0006 — Durable workflows and bounded agents

**Status:** Accepted

## Decision

Deterministic workflow code owns coordination. Models reason within bounded steps and never own authorization or retries.

## Consequences

Implementation must preserve this boundary until a superseding ADR is accepted. Tests and documentation must distinguish current reference behavior from target production behavior.
