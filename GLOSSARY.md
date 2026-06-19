# Glossary

**Adapter** — a narrow implementation of a provider-neutral domain contract for an external system.

**Agent runner** — a bounded model-execution component inside one deterministic workflow step.

**Canonical event** — an append-only versioned record of a domain or execution transition.

**Capability** — a typed tool action with declared permissions, risk, input, and output.

**Context Compiler** — the subsystem that filters, versions, scores, diversifies, budgets, and orders model context.

**Context manifest** — the record of selected and excluded context, reasons, conflicts, budgets, order, and compiler version.

**Evidence** — immutable source-derived observations and their provenance, distinct from inference.

**Memory proposal** — a candidate durable record that must pass classification, sensitivity, trust, conflict, and retention gates.

**Observation** — a source-derived fact or metric as collected at a specific time.

**Projection** — mutable state derived from canonical events for query efficiency.

**Side-effect class** — read-only, reversible write, or consequential write.

**Skill** — a task-specific procedure; it does not grant capabilities.

**Supersession** — linking a newer record to the older record it replaces without erasing history.

**Workflow** — a deterministic, versioned coordination graph containing bounded agent and tool steps.
