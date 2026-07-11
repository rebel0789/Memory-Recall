# OAF-022 Production Web Shell Note

OAF-022 provides a dependency-free routed workbench while preserving the local conformance controls. The primary workbench exposes Overview, Map, Memory, Handoffs, and Settings. Existing operational routes remain deep-linkable and are selected under their owning destination. The shell stays dependency-free and uses the loopback Control API only.

Overview operation state and coverage scope are distinct: success means the bounded scan completed, never that repository coverage is complete.

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

The shell classifies and renders loading, empty, partial, stale, success, denied, and error states. Workspace setup and local sign-in use a focused security screen outside the authenticated workbench. Recoverable authentication failures preserve bounded username and display-name drafts, keep the password only in the live input, and render the API error beside the form. Denied and error states stop at the local API boundary and do not fall back to direct storage, external network, or synthetic success data.

Authenticated Overview loads first run read-only git change detection, then sends at most 16 safe relative locators through the strict `POST /api/recall/map` read contract. The response remains the existing Recall Map DTO. Detection failure falls back to the compatible GET map. Counts distinguish detected changes from locators omitted by scan or safety bounds, and refresh repeats the same sequence.

The repository bar provides bounded global search with stable `/map?query=` history. Its repository control is intentionally not a hot switch: one loopback server is bound to one local repository. To inspect another repository, open a shell there and run `recall serve`.

## Accessibility matrix

- Skip link targets `main`.
- Desktop navigation exposes five destinations; tablet uses a 72 px semantic-icon rail with accessible names; mobile navigation exposes four and omits Settings.
- Primary and mobile navigation use landmarks and `aria-current`.
- Status uses visible text labels, not color alone.
- Live status updates are exposed through a polite live region.
- Buttons meet the 44 px target floor.
- Keyboard focus uses `:focus-visible`.
- Reduced motion is respected.
- Workflow graph information has an ordered outline equivalent.
- Table and list surfaces preserve semantic headings and row labels.

## Boundaries

The shell does not add a frontend framework, hosted service, connector, external write path, publishing path, or direct storage access. It only calls the existing loopback Control API and keeps deterministic local mode as the visible default. The POST Recall Map read is authenticated, workspace-authorized, same-origin, CSRF-protected for browser sessions, body-capped, rate-limited, strict-schema validated, and read-only; it returns no diff bodies, raw source, absolute paths, credentials, model output, or network results.
