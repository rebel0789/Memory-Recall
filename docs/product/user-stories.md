# User Stories and Acceptance Scenarios

## Local builder

As a builder, I can run the complete demo without an account or API key so I can evaluate the architecture privately. Acceptance: network is not required, external writes are false, and every output is reproducible from fixtures.

## Context reviewer

As a reviewer, I can inspect selected and excluded records with reasons so I can diagnose drift. Acceptance: budget, tokens, score, version, provenance, conflicts, and reason codes are visible.

## Memory owner

As a user, I review proposed preferences and facts before they become active memory. Acceptance: old value, proposed value, source, confidence, retention, conflict, and supersession are visible.

## Operator

As an operator, I can identify a failed step and safe retry behavior without reading raw process logs. Acceptance: outcome, current state, attempt history, sanitized error, and next safe action are present.

## Publisher

As a creator, I see exact public content and destination before approval. Acceptance: editing invalidates approval; expiry and idempotency are enforced; external publishing is disabled until configured and reviewed.
