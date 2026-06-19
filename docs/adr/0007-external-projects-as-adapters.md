# ADR 0007 — External projects remain adapters

**Status:** Accepted

## Decision

Do not merge upstream frameworks into one codebase. Pin, isolate, and map them to narrow contracts.

## Consequences

Implementation must preserve this boundary until a superseding ADR is accepted. Tests and documentation must distinguish current reference behavior from target production behavior.
