# Loop Action Efficiency

## Purpose

Keep each loop action small, reused, and measurable. Use existing repo
contracts, helpers, tests, docs, and generated artifacts before creating new
code.

## Procedure

1. Restate the current loop action and stop condition in one sentence.
2. Search for the nearest existing primitive, fixture, script, schema, or UI
   model that already covers the behavior.
3. Follow the laziness ladder in order: reuse an existing primitive, adapt the
   nearest boundary, make the smallest coherent edit, and generate new code only
   when the first three options do not satisfy the plan.
4. Before writing, name the expected file boundary and the validation command.
5. After writing, report measured effect only: changed files, diff size, and any
   available `contextBudget` values. Do not claim provider billing savings.

## Guardrails

- The skill is instruction-only and read-only. It never grants write authority.
- Do not add dependencies, adapters, daemons, schedulers, or framework layers.
- Do not broaden filesystem, network, approval, memory, or policy scope.
- Stop when the next action is outside the loop plan or needs human review.

## Completion

Return `skill:loop-action-efficiency`, status, action ladder, reused primitive,
changed boundary, validation result, measured `contextBudget` or "unestimated",
residual risk, rollback, and confirmation that no write authority was granted by
the skill itself.
