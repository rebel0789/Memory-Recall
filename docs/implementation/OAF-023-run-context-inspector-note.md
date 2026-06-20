# OAF-023 Run and Context Inspector Note

OAF-023 deepens the OAF-022 routed shell for run execution and context-selection inspection. It stays dependency-free and uses only the existing loopback Control API.

## Run Inspector

- `/runs?run=<runId>` opens a route-addressable run detail view.
- `/runs?run=<runId>&step=<stepId>` focuses a workflow step without exposing raw event payloads.
- Run cards show workflow/version, status, residency, start/duration, current step, local owner boundary, warning count, and stable link.
- Run detail shows step status, actor, attempts, duration, bounded summaries, sanitized error codes, recommendation output, manifest link, and a sanitized event table.

The event table is intentionally a sanitized trace, not a raw log. It omits raw payload bodies, prompt text, context bodies, credentials, local paths, provider URLs, hidden reasoning, SQL, cookies, tokens, and authorization material.

## Context Inspector

- `/context` shows manifest header details, selected records, excluded records, assembly sections, conflicts, and comparison.
- `/context?record=<recordId>&state=<selected|excluded>` opens a decision detail card.
- Decision cards include record ID, kind, text preview, tokens, score when available, reason codes, source, scope, version, confidence, and selected/excluded state.
- Assembly sections list selected record IDs and token totals.
- Comparison reports selected, excluded, assembly IDs, selected-missing-from-assembly, assembly-not-selected, selected/excluded overlap, and conflict count.

## Boundaries

OAF-023 does not add OAF-024 Memory, Evidence, or Approval detail views. It also does not add direct storage access, new Control API routes, external adapters, external writes, publishing, connectors, browser automation, hosted services, production authentication UI, or a frontend framework.
