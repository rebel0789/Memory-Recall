# AI-Native Component Contracts

## Run card

Required: workflow and version, status text and icon, residency, start/duration, current step, owner, warning count, stable link. Never call a run “thinking.”

OAF-023 implementation: run detail links use `/runs?run=<runId>` and step focus links use `/runs?run=<runId>&step=<stepId>`. Step cards expose actor, attempt, duration, bounded summary fields, and sanitized error code only.

## Context decision card

Required: record ID, kind, text preview, tokens, score, reason codes, source, scope, version, and selected/excluded state. Exclusion never appears as a generic “not relevant” when a precise reason exists.

OAF-023 implementation: decision detail links use `/context?record=<recordId>&state=<selected|excluded>`. Cards omit raw context bodies and show only the sanitized preview plus safe manifest metadata.

## Evidence card

Required: observed fields, source, collection method, publication/collection/metric times, hash, trust class. Inferred fields use a visibly separate section and cite the inference model/version.

OAF-024 implementation: evidence cards use `/evidence` and render source snapshot IDs, collection method, timestamps, hashes, trust class, generated claim links, staleness, and conflicts. Observed fields and inferred fields are separate panels.

## Memory diff

Required: previous and proposed values, lifecycle, source, confidence, conflict, retention, supersession, reviewer. Provide approve, edit, reject, and expiry choices according to policy.

OAF-024 implementation: memory diff cards use `/memory`, redact secret-shaped values, show lifecycle events and evidence IDs, and expose review choices as disabled inspection controls because OAF-024 adds no mutation endpoint.

## Approval card

Required: operation hash, actor, exact destination, exact content or diff, risk, policy version, expiry, idempotency, and consequence. Any edit invalidates the existing approval.

OAF-024 implementation: approval cards use `/approvals`, show exact preview fields and policy/idempotency details, mark edits as invalidating, and keep approval actions disabled while external writes remain globally disabled.

## Tool call

Required: tool/version, declared permissions, grant, sanitized input, attempt, timeout, result summary, policy decision, and event link.

## State coverage

Every component defines empty, loading, running, waiting, success, warning, denied, failed, expired, and inaccessible states where applicable.
