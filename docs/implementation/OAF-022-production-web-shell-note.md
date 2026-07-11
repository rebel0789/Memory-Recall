# OAF-022 Production Web Shell Note

OAF-022 provides a dependency-free routed workbench while preserving the local conformance controls. The primary workbench exposes Overview, Map, Memory, Handoffs, and Settings. Existing operational routes remain deep-linkable and are selected under their owning destination. The shell stays dependency-free and uses the loopback Control API only.

## Stable routes

- `/` for the repository-first Overview, including changes, attention, impact, the current handoff, recent activity, and one state-derived next action.
- `/map` for the primary Map destination; `/source-graph` remains its stable operational deep link.
- `/handoffs` for the primary Handoffs destination; `/context-pack` remains its stable operational deep link.
- `/runs` for run history and sanitized run detail.
- `/workflows` for workflow definitions and an outline equivalent to graph information.
- `/context` for selected and excluded context manifest records.
- `/memory` for memory lifecycle state.
- `/evidence` for observations separate from inference.
- `/approvals` for exact-action review boundaries and disabled publisher state.
- `/content` for candidate drafts, evidence, local approvals, and local outcome records.
- `/agents-tools` for native baselines, tool policy, and adapter status.
- `/settings` for local defaults and shared design tokens.

Legacy `?view=` links continue to resolve to stable routes for bootstrap compatibility. Secondary routes select Overview, Map, Memory, Handoffs, or Settings in the primary navigation according to route ownership.

## State coverage

The shell classifies and renders loading, empty, partial, stale, success, denied, and error states. Workspace setup and local sign-in use a focused security screen outside the authenticated workbench. Denied and error states stop at the local API boundary and do not fall back to direct storage, external network, or synthetic success data.

## Accessibility matrix

- Skip link targets `main`.
- Desktop navigation exposes five destinations; mobile navigation exposes four and omits Settings.
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
