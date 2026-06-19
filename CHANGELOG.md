# Changelog

## [Unreleased]

### Added

- OAF-009 contextual policy engine with a versioned source registry, deterministic policy fingerprint, stable denial reason codes, strict policy request/decision schemas, native deterministic `PolicyEvaluatorPort` provider, and route/tool conformance tests.
- OAF-008 native local identity provider, first-owner CLI bootstrap, browser sessions, CSRF, API tokens, deterministic workspace role/action authorization, and security audit events.
- PostgreSQL `002_identity.sql` migration for users, memberships, sessions, API tokens, and security audit events.
- OAF-007 strict Control API boundary validation with a runtime route-contract registry, response validation, stable sanitized error envelopes, and correlation IDs.
- Protocol schemas and compatibility fixtures for API errors, start-run requests/responses, run responses, context compile requests, reset responses, health responses, project status responses, path parameters, and correlation identifiers.

### Security

- Route authorization and tool invocation now use one contextual policy service after authentication and current membership resolution; denials stop before workflows, Context Compiler, model/tool providers, artifact or memory mutation, secret resolution, filesystem writes, network operations, or consequential effects.
- Policy evaluates workspace/resource ownership, API-token scope intersection, manifest-bounded tool capability, filesystem/network/secret/data-class/sandbox/budget dimensions, exact approval binding, idempotency, and the global external-write kill switch.
- Control API rejects malformed paths, unknown queries, oversized bodies, unsupported media types, unsupported content encodings, cross-origin state-changing requests, excessive JSON complexity, and invalid bodies before domain execution.
- Non-public Control API routes now require authenticated principals, explicit workspace context where applicable, deterministic authorization, and CSRF for cookie-auth unsafe requests before invoking workflows, stores, the Context Compiler, native providers, or migrations.
- Passwords are stored as versioned scrypt credentials; raw session, CSRF, and API token secrets are never persisted or returned in list/session DTOs.
- API logs and public errors use correlation IDs without exposing request bodies, stack traces, SQL, filesystem paths, headers, cookies, tokens, authorization values, or submitted values.

### Planned

- OAF-004 PostgreSQL repositories behind provider-neutral ports.
- Complete retention/export semantics for the artifact provider.
- Persisted replay and shadow execution service.

## [0.2.0-dev] — 2026-06-19

### Added

- Accepted architecture decision: build the reliability brain, adapt external organs, fork only through RFC.
- Five native provider manifests and local baseline implementations.
- Workspace-scoped SQLite + FTS5 memory with temporal filters, supersession, export, and forget.
- Content-addressed filesystem artifacts with hash verification and workspace isolation.
- Cancellable embedded workflow execution with event checkpoints.
- Explicit loopback-only Ollama provider with no silent cloud fallback.
- Portable Agent Pack schema, validation, resolution, and deterministic fingerprints.
- Side-effect-free replay plans, run comparison, and reviewable learning proposals.
- Provider-neutral ports, health normalization, envelopes, and smoke conformance.
- Versioned contract expectation fixtures for 12 external adapter targets.
- Dependency-free JSON Schema subset validator and valid/invalid/backward-compatibility fixtures.
- Native provider smoke and full handoff verification commands.

### Changed

- Foundation tasks OAF-001 through OAF-003 are complete.
- The next development task is OAF-004.
- Repository documentation now separates native providers, external adapters, adopted infrastructure, and forks.

### Security

- Agent Packs reject credential-shaped fields.
- Replays disable external writes and never reuse approvals.
- Ollama defaults to HTTP loopback only.
- Native providers enforce workspace scope and bounded input sizes.

## [0.1.0-dev] — 2026-06-19

### Added

- Agent-ready development kit and machine-readable project status.
- Dependency-free local bootstrap, dashboard, CLI, and Content Intelligence demo.
- Context Compiler reference implementation and context-selection evaluations.
- Protocol schemas, agent/skill/tool manifests, and disabled adapter plans.
- Product, brand, UX, architecture, security, testing, operations, and open-source documentation.
- Issue-sized delivery backlog and task-inspection command.

### Security

- Default-deny network posture and disabled external writes.
- Adapter pinning, permission, supply-chain, and prompt-injection gates.
