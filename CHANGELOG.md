# Changelog

## [Unreleased]

### Added

- OAF-010 context candidate-source ports with exact and lexical native providers, strict candidate-source protocol schemas/fixtures, source registry validation, provenance-preserving source hits, partial failure reports, candidate union conflict handling, and source-to-compiler composition helpers that preserve the existing synchronous compiler API.
- OAF-011 deterministic context selection policy with weighted reciprocal-rank source fusion, feature scoring, required-record fail-closed behavior, diversity and duplicate suppression, category caps and budget traces, safe selection-result schemas, and expanded context-selection evaluations.
- OAF-012 persisted context assembly and manifests with deterministic reserved sections, manifest and assembly fingerprints, provider-neutral manifest repository port, native local manifest provider, PostgreSQL append/get/list/compare/verify support, workflow/API durable composition, and expanded persisted-manifest evaluations.
- OAF-013 local model gateway with provider capability profiles, persisted context-manifest references for every structured model call, schema-validated structured output, one-call bounded repair to the same selected provider/model, timeout and cancellation propagation, safe model events, deterministic default generation, and loopback Ollama integration tests.
- OAF-014 native durable SQLite workflow provider with serializable fingerprinted definitions, stable handler registry, worker leases, process-kill recovery tests, durable timers, durable retries, approval waits, cancellation, idempotent effect records, canonical history events, durable protocol schemas/fixtures, local smoke commands, and expanded workflow recovery evaluations.
- OAF-015 native bounded tool execution with reviewed checksum-pinned catalogs, explicit-operation manifests, process-local one-use grants, brokered filesystem/loopback/secret surfaces, durable idempotent local write reconciliation, protocol schemas/fixtures, focused adversarial tests, and local smoke coverage.
- OAF-016 native evidence service with immutable source snapshot normalization, observation-to-snapshot linkage, deterministic deduplication groups, claim citation edges, staleness classification, conflict findings, and protocol schema/fixture coverage.
- OAF-017 native versioned memory write gate with deterministic proposal, verification, activation, rejection, supersession, retraction, expiry, duplicate/conflict review, secret quarantine/redaction, export filtering, lifecycle protocol fields, and focused lifecycle tests.
- OAF-018 context-use feedback with selected-record use records, outcome references that explicitly avoid causal claims, feedback summaries, reversible selector experiments, review-only default-promotion plans, protocol schemas/fixtures, and deterministic eval coverage.
- OAF-019 read-only research ingestion for bounded text, Markdown, JSON, RSS, and Atom bodies with immutable source snapshots, normalized observations, duplicate collapse, malformed-source reports, Content Intelligence workflow input support, protocol schema/fixture coverage, and focused ingestion tests.
- OAF-009 contextual policy engine with a versioned source registry, deterministic policy fingerprint, stable denial reason codes, strict policy request/decision schemas, native deterministic `PolicyEvaluatorPort` provider, and route/tool conformance tests.
- OAF-008 native local identity provider, first-owner CLI bootstrap, browser sessions, CSRF, API tokens, deterministic workspace role/action authorization, and security audit events.
- PostgreSQL `002_identity.sql` migration for users, memberships, sessions, API tokens, and security audit events.
- OAF-007 strict Control API boundary validation with a runtime route-contract registry, response validation, stable sanitized error envelopes, and correlation IDs.
- Protocol schemas and compatibility fixtures for API errors, start-run requests/responses, run responses, context compile requests, reset responses, health responses, project status responses, path parameters, and correlation identifiers.

### Security

- Candidate-source generation uses contextual policy before source invocation and candidate output, denies secret model-context records by default, preserves workspace isolation, treats exact denied/missing IDs indistinguishably, and keeps external adapters, outbound network, vector stores, embeddings, graph stores, browser automation, and public search endpoints disabled.
- Context selection uses a checked-in policy fingerprint and safe internal traces; raw source text, prompts, model reasoning, secrets, local paths, SQL, provider configuration, and authorization material are excluded from score breakdowns and decisions.
- Durable context manifest persistence now stops before model invocation when required governance is over budget or manifest append/verification fails; persisted excluded decisions omit raw text, and the persistence event contains only safe IDs, counts, fingerprints, and timestamps.
- Model gateway events record provider/model IDs, prompt/schema/output/context fingerprints, usage, validation state, and bounded repair counts only; raw prompts, context bodies, outputs, credentials, provider URLs, local paths, hidden reasoning, hosted fallback, downloads, tool calling, external connectors, publishing, embeddings, vector stores, graph stores, and browser automation remain disabled.
- Durable workflow history records bounded state transitions, timer/retry/approval IDs, operation fingerprints, and safe summaries only; raw outputs, prompts, context bodies, credentials, provider URLs, local paths, SQL, hidden reasoning, external writes, Temporal/cloud dependencies, downloaded code, and tool execution remain disabled.
- Tool execution rejects caller-supplied authority fields, uses OAF-009 as the sole policy source, mints one-use exact-operation grants only after allow, never persists or logs raw grant tokens, independently brokers filesystem, loopback egress, and secret references, and keeps external adapters, external writes, publishing, arbitrary shell execution, downloaded tools, browser automation, and public internet access disabled.
- Evidence graph construction keeps source snapshots, observations, claim inference, citation edges, staleness, and conflicts in separate records; external source content remains untrusted data and no external adapters, graph databases, vector databases, network calls, or writes are enabled.
- Memory writes are proposal-first and lifecycle-gated: model, tool, retrieved, and external content cannot silently become active memory; facts require deterministic evidence, preferences require user confirmation or verification, duplicate/conflicting records require review, and secret-shaped material is redacted and excluded from exports.
- Context feedback records manifest IDs, fingerprints, selected-record IDs, use states, and outcome references only; it rejects unselected-record use and raw output/body fields, makes `causalClaim: none`, and requires passing deterministic evaluation plus rollback before a selector-default promotion can be reviewed.
- Research ingestion is caller-supplied and bounded only: it rejects oversized or credential-bearing source locators, reports malformed JSON/RSS/Atom, preserves empty inference on observations, and keeps network fetching, cookies, paid APIs, authenticated social connectors, browser automation, external adapters, external writes, and publishing disabled.
- Route authorization and tool invocation now use one contextual policy service after authentication and current membership resolution; denials stop before workflows, Context Compiler, model/tool providers, artifact or memory mutation, secret resolution, filesystem writes, network operations, or consequential effects.
- Policy evaluates workspace/resource ownership, API-token scope intersection, manifest-bounded tool capability, filesystem/network/secret/data-class/sandbox/budget dimensions, exact approval binding, idempotency, and the global external-write kill switch.
- Control API rejects malformed paths, unknown queries, oversized bodies, unsupported media types, unsupported content encodings, cross-origin state-changing requests, excessive JSON complexity, and invalid bodies before domain execution.
- Non-public Control API routes now require authenticated principals, explicit workspace context where applicable, deterministic authorization, and CSRF for cookie-auth unsafe requests before invoking workflows, stores, the Context Compiler, native providers, or migrations.
- Passwords are stored as versioned scrypt credentials; raw session, CSRF, and API token secrets are never persisted or returned in list/session DTOs.
- API logs and public errors use correlation IDs without exposing request bodies, stack traces, SQL, filesystem paths, headers, cookies, tokens, authorization values, or submitted values.

### Planned

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
