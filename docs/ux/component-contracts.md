# AI-Native Component Contracts

## Run card

Required: workflow and version, status text and icon, residency, start/duration, current step, owner, warning count, stable link. Never call a run “thinking.”

OAF-023 implementation: run detail links use `/runs?run=<runId>` and step focus links use `/runs?run=<runId>&step=<stepId>`. Step cards expose actor, attempt, duration, bounded summary fields, and sanitized error code only.

## Context decision card

Required: record ID, kind, text preview, tokens, score, reason codes, source, scope, version, and selected/excluded state. Exclusion never appears as a generic “not relevant” when a precise reason exists.

OAF-023 implementation: decision detail links use `/context?record=<recordId>&state=<selected|excluded>`. Cards omit raw context bodies and show only the sanitized preview plus safe manifest metadata.

## Evidence card

Required: observed fields, source, collection method, publication/collection/metric times, hash, trust class. Inferred fields use a visibly separate section and cite the inference model/version.

## Memory diff

Required: previous and proposed values, lifecycle, source, confidence, conflict, retention, supersession, reviewer. Provide approve, edit, reject, and expiry choices according to policy.

## Approval card

Required: operation hash, actor, exact destination, exact content or diff, risk, policy version, expiry, idempotency, and consequence. Any edit invalidates the existing approval.

## Tool call

Required: tool/version, declared permissions, grant, sanitized input, attempt, timeout, result summary, policy decision, and event link.

## State coverage

Every component defines empty, loading, running, waiting, success, warning, denied, failed, expired, and inaccessible states where applicable.
