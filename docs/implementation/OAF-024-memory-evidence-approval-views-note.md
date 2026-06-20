# OAF-024 Memory, Evidence, and Approval Views Note

OAF-024 completes the remaining OAF-022 product-shell detail views for Memory,
Evidence, and Approvals. The implementation stays dependency-free and renders
through the authenticated loopback Control API dashboard response only.

## Memory Explorer

- `/memory` renders memory diff cards with previous and proposed values,
  lifecycle state, source, confidence, conflicts, retention, supersession,
  reviewer, evidence IDs, and lifecycle events.
- Review choices are visible as disabled controls because OAF-024 adds
  inspection only, not memory mutation endpoints.
- Secret-shaped values are redacted before rendering.

## Evidence Explorer

- `/evidence` renders source-backed evidence cards with immutable source
  snapshot IDs, collection method, publication/collection/metric times, hashes,
  trust class, linked generated claims, staleness, and conflicts.
- Observed fields and inferred fields are shown in separate sections.
- Claim links are derived from selected evidence IDs and recommendation output
  without rendering raw source bodies.

## Approval Inbox

- `/approvals` renders exact approval preview cards with operation hash, actor,
  destination, exact content or diff, risk, policy version, expiry,
  idempotency, reason codes, and consequence.
- Approval actions are disabled in this shell. Any edit is explicitly shown as
  invalidating the approval.
- External writes remain disabled and no publisher or consequential adapter is
  invoked.

## Boundaries

OAF-024 does not add production authentication UI, approval mutation APIs,
memory write APIs, direct storage reads, external adapters, external writes,
publishing, connectors, browser automation, hosted services, telemetry, or a
frontend framework.
