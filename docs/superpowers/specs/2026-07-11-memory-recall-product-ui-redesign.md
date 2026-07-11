# Memory Recall Product UI Redesign

Date: 2026-07-11

## Purpose

Replace the current operations-heavy web shell with a focused developer workbench. The redesigned product must help a developer answer four questions quickly:

1. What changed in this repository?
2. What does Memory Recall currently know?
3. What needs review?
4. What should the next coding agent receive?

The redesign must preserve Memory Recall's local-first, proposal-reviewed, source-backed behavior. It must not turn the product into a marketing site, a chat wrapper, or a decorative graph viewer.

## Current problems

The checked-in web shell exposes fifteen equal-weight destinations. The first screen repeats its title, presents most state as pills or cards, mixes initial authentication with product navigation, and gives setup, system posture, metrics, and secondary operations similar visual weight. On mobile, the same navigation model becomes a long horizontal destination strip.

The current visual system also overuses patterns associated with generic AI dashboards:

- uppercase eyebrow labels above headings;
- rounded cards around nearly every content group;
- initials used as substitute icons;
- five-column metric strips;
- mint accent color used across unrelated actions and states;
- promotional phrases inside operational screens;
- repeated hero-like introductions on internal routes.

## Product structure

The primary navigation contains five destinations.

### Overview

The daily starting point. It shows repository state, changes since the last handoff, memory requiring attention, a compact impact preview, current handoff status, and recent activity.

### Map

Repository structure, symbols, dependencies, source evidence, and changed-file impact. The graph is an inspection tool inside this destination, not the product's home page.

### Memory

Proposal review and temporal fact history. The default views are `Needs review`, `Current`, `Stale`, and `History`.

### Handoffs

Create, inspect, verify, save, and reuse context packages for supported coding tools.

### Settings

Connections, models, local storage, security, compatibility, and advanced operations.

Existing runs, workflows, context manifests, evidence, approvals, tools, and diagnostics remain available through the destination that owns them. They do not remain top-level navigation items.

## Interaction model

The main workflow is:

```text
Scan repository -> inspect impact -> review memory -> prepare handoff
```

The overview chooses one primary action from current state:

- `Scan repository` when no map exists;
- `Review N proposals` when memory is pending;
- `Update handoff` when sources changed after the current handoff;
- `View current handoff` when the handoff still verifies;
- no primary action when no work is required.

The selection is deterministic. The model does not decide which action appears.

## Shell and layout

### Desktop

- A 216 px navigation rail contains product identity, the five destinations, repository switcher, and local-state indicator.
- A compact repository bar contains repository name, branch, last scan, global search, and current system condition.
- The content region supports a primary work area and an optional 360 px inspector.
- Page headings appear once. Internal routes do not contain marketing heroes.

### Tablet

- The rail collapses to icons with accessible names.
- The inspector opens as a drawer.
- Tables retain visible horizontal-overflow cues.

### Mobile

- Four destinations appear in the bottom navigation: Overview, Map, Memory, and Handoffs.
- Settings opens from the repository bar.
- Graph content defaults to an outline or table. The canvas is optional and never squeezed into the viewport.
- List-detail transitions replace multi-column layouts.

## Visual system

The interface uses the visual language of a precise developer tool.

### Color

- Light canvas: warm off-white.
- Dark canvas: neutral graphite, not blue-black.
- Primary accent: restrained cobalt blue.
- Green, amber, and red are reserved for meaningful state.
- Gradients, glowing borders, translucent glass panels, and decorative background effects are prohibited.

### Typography

- Use the native system sans stack for interface text.
- Use the native monospace stack only for commands, paths, hashes, identifiers, and source excerpts.
- Use weight, size, and spacing for hierarchy. Do not rely on all-caps labels.

### Shape and depth

- Controls use a 6 px radius.
- Panels use an 8 px radius only when a boundary is necessary.
- Lists and related sections prefer dividers over nested cards.
- Shadows are reserved for transient overlays.
- Pills are reserved for compact filters or status values, not general metadata.

### Motion

- Animate only state changes that benefit from continuity: drawers, inserted rows, graph focus, and progress changes.
- Animate opacity and transforms only.
- Honor `prefers-reduced-motion`.
- Do not add ambient, decorative, or celebratory animation.

## Overview screen

The overview starts with the repository name and current condition. It contains:

1. Repository summary with branch, last scan, changed-file count, and handoff age.
2. One state-derived primary action.
3. Changed files, grouped by subsystem when possible.
4. `Needs attention`, containing pending, stale, conflicting, or failed items.
5. A compact impact preview with direct links into Map.
6. Current handoff verification and source coverage.
7. Recent activity as a chronological list.

The screen does not show vanity scores or metrics without an operational decision attached to them.

## Map screen

The desktop Map uses three regions:

- repository structure and filters;
- dependency or impact canvas;
- selected-node inspector with source evidence.

Search accepts files, symbols, concepts, and paths. `Changed files` is a first-class filter. Extracted and inferred relationships use distinct labels. Every graph view has an equivalent outline or table. Large repositories load detail progressively.

## Memory screen

Memory uses a review queue rather than a dashboard.

Each row shows:

- the fact;
- lifecycle state;
- source;
- age;
- the reason it needs attention.

The detail view shows provenance, conflicting facts, supersession history, cited source locators, and source-recheck status. Approval remains explicit and revalidates cited sources. Bulk approval excludes semantic proposals. Empty states explain what was checked and name the available next action.

## Handoffs screen

The default view is an automatically prepared draft containing:

- objective and current step;
- required local reads;
- changed-file coverage;
- included memories with provenance;
- excluded context with reason codes;
- estimated context size;
- verification state;
- supported consume actions.

Advanced selection controls remain behind `Edit selection`. The primary flow is review, verify, then copy, save, or connect.

## Setup

Setup is a focused flow, separate from the normal dashboard:

1. Confirm the repository.
2. Preview the first local scan.
3. Connect a supported coding tool.
4. Review proposed memories.

Local authentication may still be required by the control API, but it is presented as workspace security inside setup. The user should reach a useful repository result before encountering optional model or provider configuration.

## Copy rules

Product copy names objects, state, and actions directly.

Do not use:

- developer-first;
- nervous system;
- unlock;
- supercharge;
- AI-powered;
- magic;
- intelligent memory;
- seamless;
- next-generation;
- generic phrases such as `Something went wrong` when a bounded explanation is available.

Do not use a slogan in the product shell. Marketing pages are outside this specification.

## Error handling

Failures appear beside the operation that failed. Each recoverable error states:

1. what failed;
2. whether local state changed;
3. the safest retry;
4. a copyable diagnostic command when one exists;
5. a bounded correlation identifier when the API provides one.

Form values survive recoverable failures. Disabled actions explain why they are unavailable. Destructive or external actions retain preview and confirmation gates.

## Architecture boundaries

- Preserve the dependency-free static shell for this redesign. A framework migration requires a separate decision.
- The UI continues to read and mutate state through the loopback Control API. It does not access SQLite or files directly.
- Existing route URLs remain valid during migration. Removed top-level routes redirect or render inside their owning destination.
- Capability labels continue to distinguish implemented, experimental, reference, and unsupported behavior.
- No model output directly changes canonical memory or policy state.

## Implementation slices

1. Replace design tokens and shell primitives.
2. Reduce navigation and add repository bar.
3. Rebuild setup and Overview.
4. Rebuild Map with outline parity.
5. Rebuild Memory review queue.
6. Rebuild Handoffs flow.
7. Move secondary routes into their owning destinations.
8. Remove obsolete selectors, templates, copy, and tests.
9. Run full accessibility, responsive, browser, and release verification.

Each slice must leave existing authoritative behavior available. Temporary redirects are acceptable; duplicate long-term navigation is not.

## Verification

Automated tests must cover:

- deterministic primary-action selection;
- route and redirect behavior;
- lifecycle labels and proposal-review restrictions;
- handoff verification states;
- error copy and preserved input;
- keyboard-reachable navigation and controls;
- equivalent graph outline content;
- absence of prohibited copy in rendered routes.

Browser verification must cover:

- 1440 px desktop, tablet, and 390 px mobile layouts;
- setup, empty, loading, error, partial, stale, and success states;
- Overview, Map, Memory, Handoffs, and Settings;
- deep-link reload and browser back/forward behavior;
- keyboard-only navigation and visible focus;
- light and dark modes;
- reduced motion;
- no horizontal overflow or clipped text;
- no console or page errors.

The full repository CI, consumer smoke, consumer browser smoke, and release-readiness checks must pass before the redesign is considered complete.

## Acceptance criteria

The redesign is complete when:

- only five desktop destinations and four mobile destinations are primary;
- setup is separate from the normal overview;
- Overview supports the daily scan, review, impact, and handoff workflow;
- Map, Memory, and Handoffs implement the behaviors in this specification;
- secondary operations remain reachable without competing in primary navigation;
- prohibited visual patterns and copy are absent from the product shell;
- WCAG 2.2 AA expectations in `DESIGN.md` remain satisfied;
- real-browser verification covers all required routes and states;
- all specified automated and release gates pass.
