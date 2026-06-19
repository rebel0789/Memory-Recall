# ADR 0004 — Local-first with no silent cloud fallback

**Status:** Accepted

## Decision

The useful bootstrap works offline. Networked inference and adapters are explicit, visible, and opt-in.

## Consequences

Implementation must preserve this boundary until a superseding ADR is accepted. Tests and documentation must distinguish current reference behavior from target production behavior.
