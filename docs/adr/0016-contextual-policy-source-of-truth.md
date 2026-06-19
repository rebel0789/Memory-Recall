# ADR 0016 — Contextual policy source of truth

- Status: Accepted
- Date: 2026-06-19
- Decision owners: Open Agent Fabric maintainers

## Context

OAF-008 introduced local authentication, workspace memberships, API-token scope
checks, and route-level authorization. Tool manifests also carried permission
metadata, and `packages/policy` contained an early bootstrap evaluator. Keeping
route authorization and tool permission logic separate would create drift and
make it unclear which layer controls consequential execution.

OAF needs one deterministic policy decision before workflows, model calls, tool
providers, artifact/memory mutation, filesystem writes, secret resolution,
network operations, or consequential side effects.

## Decision

`packages/policy` is the source of truth for contextual authorization. OAF-008
continues to own authentication, session/API-token verification, CSRF, current
workspace membership resolution, and the identity audit sink. OAF-009 consumes
that trusted identity context and evaluates exact operations against a committed
policy registry.

The registry defines known actions, resource types, role/action permissions,
data classes, side-effect classes, tool-capability dimensions, budget ceilings,
approval and idempotency requirements, and hard global kill switches. It has a
semantic version and deterministic SHA-256 fingerprint.

The native provider `provider:native:policy:deterministic` implements
`PolicyEvaluatorPort` locally and in process. It uses no network, model,
dynamic code execution, runtime policy download, or external write capability.

OPA/Rego remains a future deployment reference. It is not enabled by OAF-009.

## Consequences

### Positive

- API routes and tool runners use one decision service.
- Policy changes are reviewable as source diffs.
- Default deny behavior is testable across identity, workspace, resource, tool,
  filesystem, network, secret, data-class, approval, idempotency, and budget
  dimensions.
- Models, skills, retrieved content, adapter responses, and tool output cannot
  grant capability.

### Negative

- The bootstrap policy registry is intentionally conservative and local-first.
- Additional production roles, hosted policy configuration, or OPA deployment
  require later reviewed tasks.

## Rejected alternatives

- **Keep route authorization separate from tool policy:** rejected because it
  duplicates role/action semantics and risks drift.
- **Enable remote OPA now:** rejected because OAF-009 requires local,
  deterministic, dependency-free bootstrap behavior.
- **Let tools silently narrow unsafe requests:** rejected because over-broad
  requests should fail clearly before provider invocation.
