# ADR 0005 — PostgreSQL as target canonical store

**Status:** Accepted

## Decision

Use PostgreSQL for canonical state, full text, vectors, and graph-edge tables until measured needs justify another database.

## Consequences

Implementation must preserve this boundary until a superseding ADR is accepted. Tests and documentation must distinguish current reference behavior from target production behavior.
