# Screen Specifications

## Global shell

Desktop uses persistent navigation and an optional inspector. Mobile uses compact bottom navigation. Header exposes workspace, local/network state, global run status, and pending approvals.

The implemented shell has stable routes for Home, Runs, Workflows, Context, Memory, Evidence, Approvals, Content Lab, Agents and Tools, and Settings. Legacy `?view=` links remain compatible. Every route must preserve loading, empty, partial, stale, success, denied, and error states without direct storage access or external fallback.

Accessibility requirements: skip link to main content, primary and mobile navigation landmarks, `aria-current` for active route, visible focus, reduced-motion support, text labels for every status, a live region for run actions, 44 px minimum action targets, and an outline equivalent for graph information.

## Home

Answer: “Is the system healthy, what is happening, and what needs me?” Show services, runs, approvals, residency, model mode, storage mode, and one primary action. Avoid vanity token totals and animated “thinking.”

## Runs

List: status, workflow, owner, start, duration, current step, warnings. Detail: outcome, artifacts, timeline, manifests, tool calls, approvals, evaluations, sanitized errors.

Implemented detail route: `/runs?run=<runId>` with optional `/runs?run=<runId>&step=<stepId>` focus. The timeline uses sanitized event summaries and step cards rather than raw logs or raw event payload bodies.

## Context Inspector

Header: objective, step, actor, budget, compiler version, conflict state. Sections: selected, excluded, conflicts, assembly, compare. Record: text preview, kind, tokens, score, reasons, source, time, scope, confidence, version chain.

Implemented decision route: `/context?record=<recordId>&state=<selected|excluded>`. Selected/excluded cards must keep exact reason codes visible and preserve assembly and comparison panels beside conflict status.

## Memory Explorer

Filter by kind, status, source, scope, time, confidence. Detail includes lifecycle, version diff, supersession, review, retention, provenance, and runs that used it.

## Evidence Explorer

Show immutable observation separately from inferred pattern. Include source snapshot, collection method, metric time, hash, trust, claims, and conflict/staleness.

## Approval Inbox

Show actor, exact action, destination, diff or payload, risk, policy reasons, idempotency, expiry, and consequences. Dangerous approval is never default-focused.

## Workflow Builder

Graph has an equivalent outline. Step inspector edits schemas, context policy, tools, risk, timeout, retries, approval, and compensation.

## Content Lab

Today, Evidence, Patterns, Saturation, Voice and Constraints, Experiments. Each candidate shows why now, evidence, differentiation, copying risk, proof needed, and uncertainty.
