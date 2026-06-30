# OAF-022 Production Web Shell Note

OAF-022 replaces the single-view bootstrap dashboard with a dependency-free routed web shell while preserving the local conformance controls. The shell remains static HTML, CSS, and ESM JavaScript served by the loopback Control API.

## Stable routes

- `/` for local health, run summary, approvals, residency, and the primary local demo action.
- `/runs` for run history and sanitized run detail.
- `/workflows` for workflow definitions and an outline equivalent to graph information.
- `/context` for selected and excluded context manifest records.
- `/memory` for memory lifecycle state.
- `/evidence` for observations separate from inference.
- `/approvals` for exact-action review boundaries and disabled publisher state.
- `/content` for candidate drafts, evidence, local approvals, and local outcome records.
- `/agents-tools` for native baselines, tool policy, and adapter status.
- `/settings` for local defaults and shared design tokens.

Legacy `?view=` links continue to resolve to stable routes for bootstrap compatibility.

## State coverage

The shell classifies and renders loading, empty, partial, stale, success, denied, and error states. Denied and error states stop at the local API boundary and do not fall back to direct storage, external network, or synthetic success data.

## Accessibility matrix

- Skip link targets `main`.
- Primary and mobile navigation use landmarks and `aria-current`.
- Status uses visible text labels, not color alone.
- Live status updates are exposed through a polite live region.
- Buttons meet the 44 px target floor.
- Keyboard focus uses `:focus-visible`.
- Reduced motion is respected.
- Workflow graph information has an ordered outline equivalent.
- Table and list surfaces preserve semantic headings and row labels.

## Boundaries

The shell does not add a frontend framework, hosted service, connector, browser automation, external write path, publishing path, or direct storage access. It only calls the existing loopback Control API and keeps deterministic local mode as the visible default.
