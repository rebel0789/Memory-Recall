# Memory Recall UI anti-slop review

Review date: 2026-07-19  
Reviewed commit: `c02e986`

This review covers the shipped local workbench rather than a marketing surface. Its standard is practical orientation: a developer should see repository truth, a next action, and bounded evidence before any graph density or promotional framing.

## Evidence inspected

| Surface | Evidence | Result |
| --- | --- | --- |
| Overview, desktop | Clean 1,225-tracked-file clone in `scripts/large-repository-browser-smoke.mjs` | Six of twelve groups fit in the first viewport; the full bounded outline is explicitly disclosed. |
| Overview, mobile | `consumer-browser-smoke.mjs` responsive widths and bottom navigation checks | No horizontal overflow; controls retain 44px targets. |
| Focused Map, desktop and mobile | Clean-clone screenshots and keyboard/overflow assertions | Direct `/map?group=apps%2Fweb` loads, graph labels stay bounded, outline locators use ellipsis, and the last mobile outline item clears fixed navigation. |
| Memory and handoff | Browser screenshots and route/control audit | Forms and governed state remain factual, readable, and reachable without faux product framing. |
| Every published route | `consumer-browser-smoke.mjs` route/control audit | Each route has one main landmark, one page heading, named keyboard-reachable visible controls, no console/page errors, and no horizontal overflow. |

## Composition and language

- The first screen uses a compact title, factual coverage, architecture, ranked starts, current impact, and trusted context. It does not use a marketing hero, slogan, testimonial, pricing block, decorative dashboard metric strip, or an always-on graph canvas.
- The Map starts with a direct query and a bounded result. Its graph is a drill-down, not the first-screen visual. Complete bounded records remain available in the outline rather than as overlapping canvas labels.
- Copy is descriptive and local: `Read-only / bounded metadata`, coverage, freshness, omitted counts, and explicit recovery actions. It makes no AI-performance, parity, cloud, or automation claim.
- The primary navigation is five clear developer tasks on desktop and four fixed tasks on mobile. Active state is conveyed by text weight and restrained color, not a decorative dot or animated underline.

## Visual system and motion

- The workbench uses flat, warm-neutral surfaces, native/system typography, restrained blue for selection, and directional inset selection marks. It has no blue-purple gradients, atmospheric blobs, glows, faux browser windows, giant logos, or default fill-and-outline CTA pairs in the reviewed flows.
- Borders separate live controls and data records. They do not create a decorative card grid on the Overview. Status chips are retained only where they express actual memory or handoff state.
- Content is visible before script-driven interaction. The UI does not depend on entrance animation; reduced-motion checks bound any transition or animation duration.
- Graph canvases use progressive labels, an accessible outline, and a selection inspector. The review specifically rejects the prior dense all-label graph treatment.

## Responsive, accessibility, and overflow review

- Desktop and mobile screenshots show no clipped headings, control collisions, unreadable outline labels, or bottom-navigation obstruction in the reviewed Overview and Map states.
- Long locators and labels use overflow-safe ellipsis in the architecture cards and source-map outline. The graph does not rely on text placed beyond the canvas edge.
- Every reviewed interactive control has an accessible name and keyboard reachability. The source-map outline updates the canonical selection with Enter.

## Fixes confirmed by this review

1. Architecture cards no longer stack every same-layer group into one tall column. The first screen shows six cards, with an explicit disclosure for the remaining groups.
2. A large-repository Map cannot return a schema-validation 500 from unmapped hotspot references or one-edge process records. Unsupported projection fragments are omitted rather than misrepresented.
3. The Map no longer requires an extra click after a direct deep link, and its desktop/mobile outline remains readable at bounded density.

## Decision

No decorative redesign is warranted. The current workbench is intentionally compact, factual, and local-first; adding hero art, branding effects, a broader dashboard, extra cards, or cosmetic motion would reduce clarity without helping a developer complete a task.
