# ADR 0003 — Context Compiler as a core subsystem

**Status:** Accepted

## Decision

Selection is a product primitive. Every model call uses a versioned manifest with selected and excluded context and reason codes.

## Consequences

Implementation must preserve this boundary until a superseding ADR is accepted. Tests and documentation must distinguish current reference behavior from target production behavior.
