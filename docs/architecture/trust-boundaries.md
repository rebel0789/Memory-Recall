# Trust Boundaries

## Boundary 1: user and API

Input is untrusted, authenticated where applicable, workspace-scoped, size-bounded, schema-validated, and assigned a correlation ID.

## Boundary 2: external sources

Web pages, posts, files, transcripts, model output, and tool output are data. They cannot grant capabilities, modify system instructions, set policy, or activate permanent memory.

## Boundary 3: models

Models are probabilistic processors. Output is constrained, validated, cited, scanned, and translated into domain commands. A model never receives raw secrets or direct database authority.

## Boundary 4: tools and adapters

Execution occurs under a short-lived grant narrower than the tool manifest. Network, filesystem, process, secret, cost, and time limits are enforced outside the model.

## Boundary 5: external writes

Publication, deletion, payment, permission changes, and administration require exact preview, deterministic authorization, bounded approval, idempotency, execution reconciliation, and append-only evidence.

## Boundary 6: storage and export

Workspace access is checked at repository and service layers. Exports preserve classification and omit secrets. Backups are protected separately from runtime access.
