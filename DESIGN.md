# Product Design Contract

This is the canonical UI contract. Code, prototypes, screenshots, and design-agent outputs follow it unless an approved ADR supersedes a rule.

## Locked visual system

- Genre: modern-minimal, designed as an application rather than a marketing page.
- App macrostructure: Workbench. Function and current repository state carry each screen.
- Canvas: warm off-white in light mode and neutral graphite in dark mode.
- Accent: restrained cobalt blue for focus, selection, links, and primary actions.
- Typography: native system sans for interface text; native monospace only for code, paths, hashes, commands, and identifiers.
- Shape: 6 px controls and 8 px bounded panels. Lists and dividers take priority over nested cards.
- Motion: state transitions only. No ambient or decorative animation.
- Copy: object, state, and action labels only. No product slogan inside the application shell.

## Principles

1. **Outcome first, trace on demand.** Show status and next action before logs.
2. **The interface is a glass box.** Evidence, context selection, tools, and approvals are inspectable.
3. **Chat is a control surface, not the architecture.** Core state uses structured views.
4. **Local state is visible.** Distinguish local-only, networked, and external-write operations.
5. **Consequences require friction.** Destructive or public actions require preview and confirmation.
6. **Progressive disclosure beats density.** Outcome → explanation → trace.
7. **Stable URLs are part of the data model.** Runs, artifacts, sources, memories, and workflows are deep-linkable.

## Information architecture

- **Home:** health, active runs, approvals, local services.
- **Runs:** timeline, steps, artifacts, costs, failures, replay.
- **Workflows:** graph, versions, schedules, tests.
- **Context:** manifests, selected/excluded records, conflicts, budgets.
- **Memory:** facts, episodes, preferences, versions, provenance.
- **Evidence:** snapshots, observations, and citation graph.
- **Content Lab:** angles, drafts, experiments, outcomes.
- **Agents & Tools:** manifests, permissions, compatibility, health.
- **Settings:** models, storage, policy, privacy, infrastructure.

## Layout

- Desktop: 216 px navigation rail, flexible content, optional 360 px inspector.
- Desktop primary destinations: Overview, Map, Memory, Handoffs, Settings.
- Tablet: retain the full 216 px labeled rail while inspectors collapse into the content flow.
- Mobile primary destinations: Overview, Map, Memory, Handoffs.
- Prose max width: 76 characters.
- Wide tables require visible overflow cues.

## Tokens

Executable tokens live in `packages/ui/tokens.json` and `apps/web/tokens.css`.

- Spacing: `4, 8, 12, 16, 24, 32, 48, 64`.
- Radius: controls 6 px and bounded panels 8 px.
- Prefer borders and surface contrast over shadows.

## AI-native components

- **Run card:** workflow, status, time, duration, current step, next action.
- **Run timeline:** actor, time, type, payload, model/version, manifest, validation.
- **Context card:** record, reason codes, token cost, provenance, conflicts.
- **Evidence card:** observed fields separated from inferred fields.
- **Approval card:** exact action, destination, diff, risk, idempotency, expiry.
- **Memory diff:** old/new value, source, confidence, lifecycle, supersession.
- **Tool call card:** declared permissions, sanitized input, result, retries, policy.

## Status labels

Queued · Running · Waiting for approval · Waiting for input · Completed · Completed with warnings · Failed · Cancelled · Compensating

Do not label tool execution as “Thinking.”

## Interaction rules

- Buttons use action verbs.
- Disabled controls show the reason.
- Preserve form input after recoverable errors.
- Use optimistic UI only for reversible local changes.
- External writes update after server confirmation.
- Visible keyboard focus is mandatory.
- Escape closes the topmost dismissible layer.

## Accessibility

- WCAG 2.2 AA baseline.
- 44 × 44 CSS pixel primary touch targets.
- Honor reduced motion.
- Announce run-state changes with polite live regions.
- Graphs require equivalent table or outline views.
- Charts require text summaries and data tables.
- Color is never the sole status channel.

## Design review gate

Test keyboard-only use, light/dark modes, 320 px and 1440 px widths, reduced motion, empty/loading/error/success states, deep-link reload, back/forward navigation, automated scans, and manual focus order.
