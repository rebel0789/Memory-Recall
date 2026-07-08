# Brand Guidelines

## Brand idea

Memory Recall is infrastructure with a human-readable face. It should feel **calm, exact, open, and capable**--never mystical, loud, or falsely autonomous.

## Positioning

- **Category:** local-first agent infrastructure and control plane
- **Promise:** agents whose context, actions, and evidence remain inspectable
- **Differentiator:** portable context selection and durable execution, not another chat wrapper

## Tagline

> Build agents that remember less—and know what matters.

## Supporting lines

- Local intelligence. Inspectable by default.
- Every action has evidence. Every memory has provenance.
- Models change. Your context should not.

## Voice

Use direct, builder-friendly language and measured claims.

**Do:** “The run paused because publishing requires approval.”  
**Avoid:** “One-click superintelligence.”

## Personality

- **Precise:** display source, status, time, and version.
- **Calm:** no casino-style urgency, confetti, or pulsing dashboards.
- **Transparent:** show limitations and uncertainty near decisions.
- **Builder-first:** expose inspectable contracts and exportable data.
- **Respectful:** the user remains responsible for consequential actions.

## Visual identity

The metaphor is a **woven lattice**: independent nodes become useful through explicit relationships. The mark has connected nodes and an open center, representing selection rather than accumulation.

| Token | Value | Use |
|---|---:|---|
| Ink | `#0A0B0D` | Primary dark surface and text |
| Paper | `#F7F7F4` | Light background |
| Slate | `#69707D` | Secondary text |
| Signal | `#56E0C4` | Active state and focus |
| Proof | `#8BA7FF` | Evidence relationships |
| Caution | `#F2B84B` | Pending approval |
| Danger | `#F06A6A` | Destructive actions |
| Success | `#72D39C` | Verified and completed |

Never rely on color alone. Every status includes an icon or text label.

## Typography

Use system fonts to keep the product local and fast. Do not include font files.

## Logo rules

- Keep clear space equal to one node diameter.
- Use one color at small sizes.
- Do not rotate, distort, add gradients, or animate continuously.
- Wordmark: "Memory Recall"; legacy technical shorthand: `OAF`.

## Naming

- CLI: `recall`; compatibility alias: `oaf`
- Environment variables: `OAF_*`
- npm package: `memory-recall`; internal workspace packages may keep `@open-agent-fabric/*` until a planned scope migration
- Event types: lowercase dot notation such as `run.started`
- IDs: readable prefixes such as `run_`, `evt_`, `mem_`, `ctx_`

## Public examples

Use synthetic or explicitly licensed data. Redact tokens, cookies, emails, private paths, and private source text.
