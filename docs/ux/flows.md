# Product Flows

## First local run

1. Home shows local-only health and no external connections.
2. User starts Content Intelligence.
3. Run moves through collection, normalization, context compilation, generation, and citation verification.
4. Completion shows three candidates with evidence IDs and uncertainty.
5. Local approval opens the exact editable preview and records the selected candidate, evidence, prompt, schema, and context manifest binding.
6. Local drafting verifies citations, rechecks similarity after edits, records the objective-specific outcome and edit distance, and leaves publishing disabled.
7. Context opens to inclusion and exclusion reasons.

Failure preserves the objective, shows the failed step and safe error, and offers retry only when retryable.

## Inspect context

1. Select `context.compiled` from a run.
2. Review budget, selected, excluded, conflicts, and compiler version.
3. Open a record for provenance, version, and score components.
4. Compare manifests or promote a sanitized failure into an evaluation case.

## Propose memory

1. Agent emits `memory.proposed` with source.
2. Gate evaluates novelty, classification, sensitivity, trust, conflict, and retention.
3. User confirms preferences and material decisions.
4. Activation or rejection appends a lifecycle event.

## Consequential tool use

1. Agent requests exact capability input.
2. Policy checks actor, workspace, domains, files, secrets, cost, sandbox, and risk.
3. User receives exact preview, destination, expiry, and idempotency.
4. Approved bounded grant executes once and reconciles result.

## Add an adapter

1. Choose a domain contract and use case.
2. Record exact repository, commit, checksum, license, owner, and trust boundary.
3. Keep disabled.
4. Run conformance, injection, timeout, malformed-output, and permission tests.
5. Promote only through an explicit release decision.
