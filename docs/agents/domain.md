# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout

This repo uses a single-context layout.

- Read `CONTEXT.md` at the repo root if it exists.
- Read relevant ADRs from `docs/adr/`.
- If `CONTEXT.md` does not exist, proceed silently. Do not create it upfront unless a domain-modeling task resolves concrete terms or decisions.

## Use the glossary's vocabulary

When your output names a domain concept, use the term as defined in `CONTEXT.md`.

If the concept you need is not in the glossary yet, that is a signal: either the project does not use that language, or there is a real documentation gap to resolve through domain modeling.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> Contradicts ADR-0007 - but worth reopening because...
