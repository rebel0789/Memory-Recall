# Example Development Handoff

Task and stop condition: OAF-004; add workspace-scoped PostgreSQL repositories behind existing ports without expanding into migration orchestration.

Files changed: list exact migrations, repository implementations, tests, and status documents.

Behavior added or corrected: canonical records persist in PostgreSQL while file and SQLite providers remain conformance baselines.

Tests and evaluations run: include exact commands, test counts, and recovery or isolation evidence.

Security and permission impact: document workspace filters, database credentials boundary, and default-deny behavior.

Data or migration impact: identify every new migration and rollback limitation.

Known limitations: state what remains for OAF-005 and OAF-006.

Rollback: revert the repository implementation and migration before any production data exists.

Safest next task: OAF-005 after OAF-004 acceptance passes.
