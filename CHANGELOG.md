# Changelog

## [Unreleased] — 1.1.1 patch candidate

### Added

- Approved the Rust/Node production-engine boundary, added provider-neutral graph and language-evidence contracts, pinned a 42-repository Tier 1 benchmark corpus, and recorded a clean Phase 0 baseline. The baseline makes no competitor-parity claim.
- Added explicit `native-preview` and `compatibility` modes to graph read commands through a versioned, bounded Rust provider. The JS engine remains the default; MCP uses it unless the server is started with the explicit read-only native preview.
- Added isolated packed-package proof and a reproducible Phase 1 compatibility receipt across JS/TS fixtures and two exact-commit repositories. The receipt records current import and call gaps and makes no accuracy, parity, or leadership claim.
- Added PHP and Ruby native-preview structure, namespaces, traits and mixins, typed calls, imports, and framework-route evidence, completing the five planned Tier 1 language batches.
- Added a deterministic Phase 2 aggregate over 14 fixtures and all 42 pinned Tier 1 repositories, with per-capability worst-case status, response bytes, resource measurements, and explicit node and edge budget diagnostics.
- Added an isolated SQLite native source index with generation commits, incremental refresh, bounded queries, doctor/confirm-gated repair, and a no-write MCP preview. A reviewed integration fixture proves build, query, and exact no-op refresh behavior for all 14 Tier 1 languages.
- Added deterministic bounded communities and evidence-backed entry-to-sink processes to the existing native `repo.architecture` MCP result, plus a reproducible Phase 4 correctness and query-deadline receipt. The MCP surface remains twelve read-only tools and no parity claim is made.
- Added five optional native-platform package templates, exact npm/Cargo/binary version alignment, a verified platform-binary resolver, and an offline macOS arm64 installed-package gate covering all fourteen Tier 1 parsers and the SQLite lifecycle without a compiler. A five-runner CI matrix now defines the same exact-tarball gate for the remaining targets, but those hosted runs, signing, and publication remain unproven; JS remains the public default.

### Fixed

- Default packaged benchmarks now use bundled fixtures unless the caller explicitly supplies `--dataset`, preventing same-named repository files from changing the package benchmark.
- `recall serve` now forwards interrupt and termination signals to the Control API child process.
- Raised the native provider output ceiling within its existing 10 MB hard maximum so valid 5,000-node engine responses do not fail on medium repositories.
- Native `index.status` now verifies the active SQLite generation against a bounded source snapshot and reports changed, added, deleted, partial, or unverified state without writing the database. Normal queries remain SQLite-only, and stale source state requires refresh rather than repair.

### Changed

- Token Saver and handoff measurement reuse the already-built context pack for their real MCP stdio readback, avoiding a second repository scan while preserving fingerprint verification.
- Native changed-file refresh now parses only the bounded invalidation closure plus dependency context. The clean Phase 3 receipt covers 781 files across one dependency fixture and three pinned repository scopes; it keeps scale, competitor, parity, and leadership claims false.
- Tier 1 documentation now names the 46 capability rows that meet the sampled Phase 2 floor and the 108 rows that remain unmeasured or not applicable. Every language remains overall unmeasured, the JS engine remains the public default, and no competitor, parity, leadership, multi-repository, or scale claim is made.
- The npm package excludes checkout-only Tier 1 audit scripts and the 114 KiB capability matrix, keeping the verified unpacked package below its fixed size ceiling.

## [1.1.0] — 2026-07-15

No breaking CLI migration is required. Local-only defaults, proposal-gated memory, and read-only MCP remain unchanged.

### Added

- Developer-first Recall Map across the CLI, loopback Control API, web home, and read-only MCP, with source-graph ranking, changed-file impact, coverage states, handoff actions, and inspectable local reports.
- Governed semantic setup commands for bounded planning, harness task generation, result import, and optional one-shot Gemini or OpenAI-compatible execution.
- Source-bound semantic proposals that remain pending until named approval rechecks every cited file.
- Public semantic setup usage, architecture, support, capability, and release evidence.

### Changed

- Canonical repository guidance, citation metadata, support links, project status, and generated manifest now use Memory Recall; legacy `oaf` commands, URIs, task IDs, and internal package scopes remain compatibility identifiers.
- Replaced the fifteen-item dashboard navigation with a five-destination workbench, separated local workspace setup from Overview, and made Overview choose one deterministic scan, review, or handoff action from current local state.
- Overview now hydrates bounded multi-file impact from current read-only git detection, preserves omitted-change evidence, reports degraded detection without claiming a clean tree, surfaces blocked handoffs, and exposes repository search with stable Map history and explicit failure states.
- The repository bar now documents the one-repository-per-server boundary, and tablet navigation collapses to a semantic 72 px icon rail with accessible labels.
- The preserved `skill:oaf-memory` compatibility package now documents current Memory Recall commands and removes unavailable legacy workflow guidance.
- Public product copy now separates implemented semantic proposal generation from experimental direct API execution and from unsupported semantic retrieval.

### Security

- Semantic source reads use bounded descriptors, no-follow and containment checks, file-identity verification, mutation detection, secret filtering, and raw-byte hashes.
- Direct API execution requires explicit network consent before environment credential access, permits HTTPS or literal-loopback HTTP endpoints only, makes one bounded request without retry or fallback, and validates untrusted output against a strict schema.
- Bulk approval skips semantic proposals. Named CLI and authenticated Control API approval paths rehash all cited sources before any proposal claim or active-memory mutation.
- Multi-locator Recall Map reads use strict request validation, a 16-locator cap, authenticated workspace authorization, same-origin and session CSRF checks, request throttling, and the existing no-write Recall Map response.
- Recoverable local-auth failures keep passwords only in the live form control; bounded non-secret draft fields and the real API error remain visible without credential serialization.

### Internal

- Release gates cover the full Node suite, 182 protocol fixtures, 144 evaluation assertions, installed-package smoke, browser smoke, package-content verification, and release-evidence drift checks.

## [1.0.5] — 2026-07-09

### Added

- Bounded source-graph commands, previews, protocol examples, measurements, and focused validation coverage.

### Changed

- GitHub release metadata now points to the exact commit recorded by the published `memory-recall@1.0.5` package.

## [1.0.4] — 2026-07-08

### Added

- Model-free LoCoMo-shaped retrieval benchmark with a small checked-in smoke fixture.

### Changed

- Public benchmark copy distinguishes retrieval coverage from official generative QA scoring.

## [1.0.0] — 2026-07-08

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
- OAF-020 deterministic Content Intelligence pattern analysis with separated raw metrics and inference, relative performance against supplied baselines, pattern shape extraction, clusters, lifecycle, proof-needed reasons, uncertainty, lexical similarity, copying-risk safeguards, workflow analysis records, protocol schema/fixture coverage, and deterministic eval assertions.
- OAF-021 local creator completion records with exact editable candidate approvals, operation-fingerprint binding to evidence, prompt/schema/context versions, local draft creation, citation and similarity rechecks after edits, objective-specific outcome metrics, edit-distance recording, protocol schema/fixture coverage, and deterministic eval assertions.
- OAF-022 production web shell with stable path routes, shared design tokens, legacy view compatibility, state classification for loading/empty/partial/stale/success/denied/error, desktop rail navigation, mobile bottom navigation, local demo controls, and focused accessibility coverage.
- OAF-023 Run and Context Inspector views with stable run and step deep links, sanitized event timeline, step detail cards, selected/excluded context decision cards, manifest assembly sections, conflict and comparison panels, and focused web-shell coverage.
- OAF-024 Memory, Evidence, and Approval views with memory diff cards, source snapshot and claim-linked evidence cards, exact approval preview cards, secret-shaped value redaction, disabled inspection-only review controls, and focused keyboard/mobile shell coverage.
- OAF-025 OpenTelemetry-compatible local instrumentation with dependency-free no-op, in-memory, and explicit loopback OTLP HTTP exporters; stable redacted span attributes; Control API route spans; workflow run/step trace propagation; model gateway spans; tool registry spans; and focused observability tests.
- OAF-026 evaluation laboratory with dependency-free versioned datasets, experiments, reports, deterministic merge gates, model-quality shadow suites, sanitized trace promotion, protocol schemas/fixtures, lab artifacts under `evals/lab`, focused tests, and deterministic eval assertions.
- OAF-027 experimental no-install ECC reviewed-procedure adapter with exact upstream commit pin, archive checksum, MIT license review, disabled-by-default manifest status, reviewed minimal procedure metadata, executable conformance fixture, and focused adversarial tests for grants, malformed output, oversized output, timeout, cancellation, and non-mutation.
- OAF-028 dependency-free MCP protocol bridge with JSON-RPC-shaped initialize, ping, tool listing/call, resource listing/read handling, trusted-context identity checks, exact server-side grants, replay-side-effect denial, disconnect cancellation, safe events, protocol schema/fixture coverage, and focused bridge tests.
- OAF-029 local operations backup, restore, upgrade, and rollback rehearsal with component checksum manifests, artifact export import, migration-status compatibility checks, deployment profile verification, diagnostics redaction, rollback plans, `ops:smoke`, and native smoke coverage.
- OAF-030 release-readiness evidence with deterministic SBOM and provenance generation, compatibility matrix, security review, adapter certification criteria, third-party notice review, north-star gap audit, release checklist, repository-specific GitHub ownership/support metadata, `release:readiness`, and focused release-readiness tests.
- Opt-in deterministic Context Compiler views for noisy logs, code, JSON, Markdown, text, and tool-output records, with secret/path redaction, original/view hashes, manifest representation metadata, and token-accounting loss notes.
- Read-only local hook context command and dry-run harness setup hook snippets for supported local clients, without transcript capture, memory activation, authority grants, network calls, adapter enablement, or home-config writes.
- Source-only setup and verify CLI wrappers, read-only MCP fallback documentation, manual harness setup/rollback receipts, context-recall budget metrics, and explicit unpublished distribution status.
- Local npm tarball install path for the `oaf` CLI, with package contents excluding private scratch notes, local client config, generated state, and research-only docs while keeping hook install/uninstall manual and read-only by default.
- Narrow `oaf connect` and `oaf disconnect` CLI commands for Codex and Claude Code, with dry-run default, explicit `--yes` home-config writes, backups, receipts, fixed read-only MCP/hook entries, and a read-only `context retrieve` command for recovering verified local context by locator or hash.
- Read-only `oaf memory refine` report for duplicate, conflicting, stale, supersession, and lineage-residue temporal-memory candidates, with schema validation and no active memory writes, model calls, network calls, or hard deletes.
- Read-only context receive receiver packets with versioned typed safe message parts, recipient-proof readiness validation, summary stdout, required-read plan, and next actions, without adding protocol adapters, MCP tools, raw source bodies, or write authority.
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
- Pattern analysis keeps raw metrics separate from derived inference, treats baseline-free metrics as insufficient proof, excludes source text from cluster summaries, and keeps publishing, hosted analytics, external telemetry, embeddings, vector databases, graph databases, and learned ranking disabled.
- Local drafting binds approval to the candidate, evidence IDs, context manifest, prompt version, output schema version, provider/model metadata, and an operation fingerprint; draft verification excludes raw source text from similarity reports and keeps publishers, external writes, external adapters, browser automation, and authenticated social connectors disabled.
- The production web shell calls only the loopback Control API, renders denied/error states without direct storage access or external fallback, and keeps deterministic local mode, external writes disabled, and adapter status visible.
- Run and Context Inspector surfaces render sanitized summaries only; raw event payloads, prompts, context bodies, credentials, local paths, provider URLs, hidden reasoning, SQL, cookies, tokens, and authorization material are not displayed.
- Memory, Evidence, and Approval views render through the loopback Control API only, redact secret-shaped memory text, separate observations from inference, show exact approval previews without executing decisions, and keep external writes, publishing, direct storage reads, and new mutation endpoints disabled.
- Observability spans drop prompt, body, source content, text, credential, cookie, authorization, secret, token, local path, URL, SQL, and hidden-reasoning attributes before export. The OTLP HTTP exporter is disabled by default and accepts only explicit loopback collector endpoints.
- Evaluation trace promotion requires classification review and stores fingerprints plus safe attributes only; raw prompts, context bodies, outputs, credentials, provider URLs, local paths, hidden reasoning, SQL, cookies, tokens, authorization material, and private source bodies are excluded. Model-quality suites remain shadow-only and do not change defaults or block CI without a reviewed report and rollback plan.
- The ECC adapter remains disabled by default and does not install, execute, vendor, or bulk-load upstream ECC content. It exposes only reviewed proposal metadata, requires an exact operation grant, rejects raw upstream fields, oversized output, timeout, and cancellation failures closed, and never mutates canonical state directly.
- The MCP bridge does not create a network listener, stdio server, hosted bridge, or external adapter. Remote protocol callers cannot supply identity, role, membership, grants, grant tokens, approval state, filesystem/network authority, or external-write authority; calls require OAF trusted context and server-side exact grants, and replay mode denies side-effecting tools before invocation.
- Operations backup and restore verify manifest fingerprints, manifest checksum sidecars, component checksums, migration status, artifact export fingerprints, artifact object hashes, version compatibility, and external-write-disabled state before restore. Diagnostics redact credentials, raw bodies, prompts, outputs, provider URLs, local paths, SQL, cookies, tokens, authorization values, and hidden reasoning.
- Release readiness keeps final merge, signing, and product 1.0 publication as explicit human approval gates; SBOM/provenance generation does not publish artifacts, store signing keys, enable external writes, or enable external adapters.
- Context views are explicit per-record representations only: they preserve original content hashes for recovery, redact secret-shaped values and private local paths, and do not enable automatic memory writes, external adapters, proxying, embeddings, vector stores, graph stores, browser automation, outbound network, or canonical source replacement.
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

- Accepted architecture decision: build the whole local tool, own the boundaries, and fork only through RFC.
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
