# ADR 0002 — Canonical append-only event ledger

**Status:** Accepted

## Decision

Record state transitions as versioned append-only events and build query projections. Correct with new events rather than editing history.

## Consequences

Implementation must preserve this boundary until a superseding ADR is accepted. Tests and documentation must distinguish current reference behavior from target production behavior.
