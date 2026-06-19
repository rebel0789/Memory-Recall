# ADR 0001 — Modular monolith first

**Status:** Accepted

## Decision

Start with explicit in-process modules and isolate only security, scaling, durability, or licensing boundaries. This minimizes deployment complexity while preserving replaceable ports.

## Consequences

Implementation must preserve this boundary until a superseding ADR is accepted. Tests and documentation must distinguish current reference behavior from target production behavior.
