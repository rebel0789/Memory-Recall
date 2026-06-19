# Parallelization Rules

After OAF-003, agents may work in parallel only when owned paths and contracts do not overlap.

## Serialized areas

One integration owner at a time for:

- protocol schemas and event types;
- database migrations;
- authorization and approval semantics;
- Context Compiler scoring and manifest format;
- design tokens;
- workflow state transitions;
- release and license policy.

## Safe parallel examples

- documentation and deterministic fixture improvements with no contract change;
- independent adapter research while adapters remain disabled;
- UI component implementation against frozen APIs;
- evaluation dataset additions that do not change default thresholds.

## Handoff contract

Each agent records base commit, task ID, owned paths, schema assumptions, test commands, generated artifacts, and unresolved conflicts. Merge shared-contract changes before dependent branches rebase.
