# Loop Workbench

Loop Workbench is Open Agent Fabric's native **loop-engineering** surface. It is
how a developer designs, runs, observes, and improves the feedback loops that let
a coding agent do real work — safely, cheaply, and with proof of what happened.

> Loop engineering is replacing yourself as the person who prompts the agent.
> You design the system that does it instead.

This document is the product north star. It is intentionally honest about what is
built and what is not. `PROJECT_STATUS.json` is the machine-readable source of
truth for capability status.

## The loop

```text
intent -> context -> action -> observation -> adjustment -> stop or repeat
```

This is the canonical loop-engineering cycle. OAF's differentiation is not the
loop shape (everyone has that); it is that **every stage is governed, measured,
and replayable** by primitives OAF already owns:

| Loop stage   | OAF primitive that backs it                                  |
| ------------ | ------------------------------------------------------------ |
| intent       | objective + stop condition + non-goals (the Loop Plan)       |
| context      | Source Graph + Context Compiler + Context Pack (locators)    |
| action       | bounded agent runner under policy and approvals              |
| observation  | event ledger + flight recorder                               |
| adjustment   | run comparison, shadow runs, learning proposals              |
| stop/repeat  | explicit stop reasons, max iterations, timeout, safeguards   |

## Why this saves tokens and memory

OAF does not save tokens by adding a loop. It saves tokens because the loop
**reuses a small, stable, fingerprinted context reference** instead of re-sending
the repository on every iteration:

- **Source Graph** returns a scoped subgraph, not the whole tree.
- **Context Pack** hands off workspace-relative locators and content hashes, not
  raw file bodies.
- **Context Compiler** selects the smallest sufficient context with explicit
  selected/excluded reason codes.
- A **measured delivery budget** (`context-pack-measurement-report`) reports
  `contentTokenCount`, source-body tokens excluded, and an
  `observedDeliveryReductionRatio` — so the saving is proven per run, not claimed.

The same discipline applies to memory: durable knowledge enters only through the
**proposal gate**, never automatically. The loop remembers less and proves more.

This honesty is a brand requirement. Loop Workbench reports measured numbers; it
does not advertise unproven savings. Published agent-efficiency results from
external skills (for example a "lazy senior developer" review skill that reduces
generated lines of code) are cited as that skill's measured effect, not
reattributed to OAF.

## Agents monitoring agents (maker / checker)

The reliability core is what makes unattended loops safe. The pattern is a
**maker/checker split**: an implementer sub-agent makes a change in an isolated
worktree, and a verifier sub-agent checks it against tests, type checks, and
policy gates before anything merges. Agent runs are trees, not log lines — the
flight recorder records the parent run, sub-agent handoffs, tool calls, policy
decisions, and outcomes required to replay and compare.

The shipped primitive is a schema-validated verification report: an injected
implementer changes an isolated worktree, a checker runs only the Loop Plan's
validation commands, unrelated diffs block the proposal, replay mode disables
side effects, and auto-merge stays off. This is not yet a scheduler or autonomous
executor.

## Delivery slices

Loop Workbench ships as small, independently verifiable bricks. No slice claims
the whole product is done.

1. **Slice 1 — Read-only Loop Plan generator.** A schema-backed, deterministic,
   sanitized plan from an objective, stop condition, validation commands, Source
   Graph hints, and Context Pack / use-plan references. No executor, no command
   execution, no observation capture, no UI. Carries a `contextBudget`.
2. **Slice 2 — Sanitized observation capture.** Record validation results and
   loop events to the event ledger, redacted and bounded to the Loop Plan's own
   validation commands.
3. **Slice 3 — Maker/checker verifier.** A schema-backed report from an isolated
   worktree, injected implementer, plan-limited checker commands, unrelated-diff
   blocking, replay side-effect proof, flight-recorder events, and a blocked or
   proposed human-reviewed proposal. No auto-merge.
4. **Slice 4 — Scheduling / automation.** A bounded loop-run projection over the
   durable workflow runtime: max iterations, timeout stop reasons, contextBudget
   aggregation, durable history/resume proof, human approval gates, and opt-in
   schedule prompt reports for triage, PR babysitter, and CI sweeper. No
   background daemon.
5. **Slice 5 — Loop Workbench UI.** The `/loop-workbench` route: dependency-free
   web shell views over plan, runs, observations, verification, token budget,
   stop reasons, and trace, backed by the local Control API read model.

Two skills layer across all slices: an **Action-stage efficiency skill** (reuse
before generate; smallest change that works) and an **Intent-stage clarification
skill** (interrogate the objective before work begins).

## Hard boundaries (apply to every slice until explicitly lifted)

- No new autonomous executor in the first slice.
- No running user commands as part of planning.
- No runtime dependencies, no network, no model calls in read-only paths.
- No automatic memory activation; proposal gate only.
- No hidden transcript or reasoning capture.
- No browser or account automation.
- No unbounded autonomous retries.
- Replays disable external side effects and never reuse approvals.

## What is not claimed

Proof summaries, reusable loop templates, and any autonomous executor are
**specified and planned, not shipped**. The shipped native primitives are the
Loop Plan generator, sanitized observation capture, maker/checker verification
report, bounded loop-run projection with opt-in schedule prompt reports, and the
`/loop-workbench` read surface.
