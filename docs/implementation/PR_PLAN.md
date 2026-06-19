# Pull Request Plan

Keep every pull request runnable and limited to one architectural concern.

## Sequence

1. `chore/verify-kit` — OAF-001.
2. `rfc/protocol-v1` — OAF-002.
3. `feat/application-ports` — OAF-003.
4. `feat/postgres-repository` — OAF-004.
5. `feat/migration-runner` — OAF-005.
6. `feat/artifact-store` — OAF-006.
7. `feat/api-validation` — OAF-007.
8. `feat/local-identity` — OAF-008.
9. `feat/policy-port` — OAF-009.
10. `feat/context-candidates` — OAF-010.
11. `feat/context-reranker` — OAF-011.
12. `feat/context-manifest-store` — OAF-012.
13. `feat/local-model-gateway` — OAF-013.
14. `feat/durable-runtime` — OAF-014.
15. `feat/tool-execution` — OAF-015.
16. `feat/evidence-service` — OAF-016.
17. `feat/memory-backend` — OAF-017.
18. `feat/context-outcome-feedback` — OAF-018.
19. `feat/rss-file-ingestion` — OAF-019.
20. `feat/content-patterns` — OAF-020.
21. `feat/content-approval` — OAF-021.
22. `feat/production-ui-shell` — OAF-022.
23. `feat/run-context-inspector` — OAF-023.
24. `feat/memory-evidence-approval-ui` — OAF-024.
25. `feat/otel-instrumentation` — OAF-025.
26. `feat/evaluation-lab` — OAF-026.
27. `feat/first-external-adapter` — OAF-027.
28. `feat/protocol-bridges` — OAF-028.
29. `feat/operations-readiness` — OAF-029.
30. `release/1.0-readiness` — OAF-030.

Use the task command for dependencies and stop conditions. Never combine a security boundary, migration, adapter promotion, and UI redesign in one pull request.
