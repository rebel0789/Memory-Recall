# Memory Recall Polyglot Phase 2 Implementation Plan

> Status: approved under the active polyglot leadership goal. Routine local implementation, tests, evidence generation, and commits are pre-approved. Push, merge, publish, deploy, and public release remain outside this plan.

**Goal:** Bring all fourteen Tier 1 languages through the same source-backed fixture and pinned-repository gates, while keeping the JS engine as the public default until native accuracy, package, and later distribution gates pass.

**Architecture:** Extend the existing Rust Tree-sitter ingest pipeline and provider-neutral graph. Language-specific extraction creates normalized declarations and unresolved relationships first; deterministic repository-level resolvers then produce imports, heritage, typed calls, routes, and confidence evidence. Benchmark truth stays separate from engine output. Node remains the CLI/control plane and the existing JS/TS engine remains the default throughout Phase 2.

**Quality rule:** Loading a grammar is not support. A capability can move from `unmeasured` only when deterministic fixtures and sampled truth from all three pinned repositories for that language exist. `full` additionally requires every applicable published floor. Missing or non-applicable behavior is explicit; it is never inferred from graph density.

## Non-negotiable boundaries

- The public CLI and all MCP tools remain on `engine=js` by default.
- Native graph access remains explicit, read-only, local, bounded, and preview-only.
- No source body, absolute checkout path, environment value, command output, or credential enters a committed evidence report.
- Canonical memory is never changed by indexing, benchmarking, or compatibility work.
- Relationship evidence names a syntax/config locator and confidence class.
- Unresolved calls/imports/heritage remain unresolved records or diagnostics; they are not converted to guessed exact edges.
- Each real-repository case is pinned to the Phase 0 corpus commit and names its bounded scope.
- Framework claims require syntax-backed or configuration-backed handlers and routes.
- Capability matrices report `full`, `partial`, `parse-only`, or `unsupported` independently from the benchmark state `unmeasured`, `does-not-meet-floor`, or `meets-floor`.
- No competitor, parity, leadership, fourteen-language, or scale claim changes in Phase 2.
- Every task is an additive commit and leaves the previous public runtime available.

## Published floors

- symbol recall: at least 0.95;
- resolved-call precision: at least 0.90;
- duplicate canonical symbols: 0;
- deterministic structural fingerprints: required;
- malformed-file repository failures: 0;
- explicit partial and unsupported diagnostics: required;
- real-repository evidence: required.

Recall and precision require reviewed truth records. Compatibility against the Node graph is diagnostic only and cannot satisfy an accuracy floor.

## Batch order

| Batch | Languages | Required resolution focus |
| --- | --- | --- |
| A | JavaScript, TypeScript | relative/package imports, CommonJS, exports/re-exports, typed receivers, route handlers, native-vs-current regression |
| B | Python, Go, Rust | modules/crates/packages, receiver resolution, traits/interfaces, Flask/FastAPI/Django, net/http/Gin/Echo/Chi, Axum/Actix/Rocket |
| C | Java, Kotlin, C# | packages/namespaces, overload-safe receivers, heritage, annotations, Spring/Ktor/ASP.NET routes |
| D | C, C++, Swift, Dart | includes/modules, declarations and receivers, protocols/heritage, Vapor/Shelf/Flutter entry points, build-target evidence |
| E | PHP, Ruby | namespace/package conventions, traits/mixins, dynamic-dispatch confidence, Laravel/Symfony/Rails structure |

## Task 1: Add reviewable language truth contracts and a deterministic evaluator

**Files:**

- Create: `packages/protocol/schemas/code-intelligence-language-truth.schema.json`
- Create: `packages/protocol/schemas/code-intelligence-language-report.schema.json`
- Create: `packages/protocol/src/code-intelligence-evaluation.mjs`
- Modify: `packages/protocol/src/index.mjs`
- Modify: `packages/protocol/README.md`
- Create: `examples/protocol/code-intelligence-language-truth.json`
- Create: `examples/protocol/code-intelligence-language-report.json`
- Create: invalid compatibility fixtures for raw bodies, absolute paths, duplicate truth IDs, and unsupported full claims
- Modify: `examples/protocol/compatibility/fixtures.json`
- Create: `tests/code-intelligence-language-evaluation.test.mjs`
- Create: `evals/code-intelligence/truth/README.md`

- [x] **Step 1: Write failing protocol and evaluator tests**

Require closed schemas for a fixture or real-repository truth manifest and its sanitized result. Truth items identify language, capability, repository ref or fixture ref, locator, stable semantic key, expected presence/absence, relationship resolution, and review provenance. They never contain source text. Reject absolute paths, repository escapes, duplicate IDs/semantic keys, raw bodies, missing locators, and `full` claims without fixture plus real-repository evidence.

- [x] **Step 2: Implement deterministic metric evaluation**

Evaluate declaration recall, relationship recall, resolved-call precision, duplicate canonical symbols, parse failures, deterministic fingerprints, and explicit partial states. Separate applicable, non-applicable, unsupported, and unmeasured cells. Produce per-case, per-language, and per-capability results with numerator/denominator counts so no percentage can hide a zero-sized sample.

- [x] **Step 3: Add evidence review rules**

Document how truth records are selected and reviewed: all fixture facts, plus stable sampled declarations/imports/heritage/calls/routes from each pinned repository. Record exact commit and bounded scope. A generator may propose samples, but a checked-in truth record requires source-locator review and must not be generated from the engine being evaluated.

- [x] **Step 4: Verify and commit the evaluation foundation**

Run:

```bash
node --test tests/code-intelligence-language-evaluation.test.mjs tests/code-intelligence-contract.test.mjs
npm run protocol:validate
npm run check
git diff --check
```

Commit: `feat: add polyglot truth evaluation contracts`

## Task 2: Close Batch A JS/TS native gaps before using it as the resolver reference

**Files:**

- Modify: `rust/oaf-ingest/src/lib.rs`
- Modify: `rust/oaf/src/code_intelligence.rs`
- Create: `evals/code-intelligence/truth/fixtures/javascript.json`
- Create: `evals/code-intelligence/truth/fixtures/typescript.json`
- Create: `evals/code-intelligence/truth/repositories/javascript/*.json`
- Create: `evals/code-intelligence/truth/repositories/typescript/*.json`
- Create: `scripts/code-intelligence-batch-a.mjs`
- Create: `evals/code-intelligence/results/phase2-batch-a.json`
- Modify: `tests/native-code-intelligence-provider.test.mjs`
- Add focused Rust tests in `rust/oaf-ingest/src/lib.rs`

- [x] **Step 1: Turn Phase 1 gaps into failing fixtures**

Cover ESM relative imports, package imports, aliases, CommonJS `require`, exports and re-exports, nested functions, class/interface/type declarations, receiver methods, constructors, typed calls, unresolved calls, Node HTTP, Express, Fastify, NestJS, and Next.js server routes. Reproduce the Phase 1 TypeScript import mismatch and Express CommonJS import/call gaps.

- [x] **Step 2: Normalize declarations and relationships**

Give symbols repository-unique qualified names that include module and owner scope. Preserve function/method/type distinctions. Emit export/re-export, construct, inheritance/implementation, and unresolved-call facts with exact syntax spans. Prevent module targets from being emitted as functions.

- [x] **Step 3: Add deterministic JS/TS resolution**

Resolve extensions, index files, package entry points, TypeScript path aliases only when configuration evidence exists, CommonJS imports, receiver calls with explicit types/constructors, and route handlers. Confidence is `exact`, `typed`, `inferred`, or `unresolved`; lexical matches cannot become typed edges.

- [x] **Step 4: Run all six pinned JS/TS repositories**

Use the three TypeScript and three JavaScript corpus commits. Record bounded scopes, graph fingerprints, truth counts, recall/precision, duplicates, parse failures, time, RSS, and disk-neutral read behavior. If a floor fails, keep the matrix partial/unmeasured or `does-not-meet-floor` and preserve the failing evidence.

- [x] **Step 5: Verify and commit Batch A**

Run focused Rust, provider, graph compatibility, fixture evaluation, real-repository evidence, packed-consumer, and default-engine tests.

Commit: `feat: close native javascript typescript gaps`

## Task 3: Complete Batch B Python, Go, and Rust

**Files:**

- Modify: `rust/oaf-ingest/src/lib.rs`
- Modify: `rust/oaf/src/code_intelligence.rs`
- Create: fixture truth for Python, Go, and Rust
- Create: nine pinned-repository truth manifests
- Create: `scripts/code-intelligence-batch-b.mjs`
- Create: `evals/code-intelligence/results/phase2-batch-b.json`
- Add focused Rust and Node contract tests

- [x] **Step 1: Add failing language fixtures**

Python: packages/modules, relative imports, aliases, classes, inheritance, decorators, type annotations, constructor receiver calls, Flask/FastAPI/Django routes.

Go: packages/modules, imports/aliases, functions, methods and receivers, structs/interfaces/embedding, constructor patterns, net/http/Gin/Echo/Chi routes.

Rust: crates/modules/use paths, functions/impl methods, structs/enums/traits, trait implementations, typed receiver calls, Axum/Actix/Rocket routes.

- [x] **Step 2: Implement package/module and heritage models**

Extend manifest/config inputs for `pyproject.toml`, package markers, `go.mod`, Cargo workspaces/features, and language-specific module paths. Add `inherits`, `implements`, `extends`, `constructs`, and typed-call facts with evidence. Unsupported dynamic edges remain unresolved.

- [x] **Step 3: Implement initial framework routes**

Routes require syntax/config evidence for method, normalized path, handler, and owning module. String literals alone are candidates, not exact route edges.

- [x] **Step 4: Run all nine pinned repositories and record exact truth capability cells**

The public aggregate capability matrix remains unchanged until Task 7 can apply the worst-case rule across all fourteen Tier 1 languages.

No language-level pass is allowed unless all three repositories and fixtures run deterministically. Capabilities that miss floors remain partial or `does-not-meet-floor` with the failure counts retained.

- [x] **Step 5: Verify and commit Batch B**

Commit: `feat: add python go rust intelligence batch`

## Task 4: Complete Batch C Java, Kotlin, and C#

**Files:**

- Modify the Rust extractor/resolver and provider graph mapping
- Add fixture truth for Java, Kotlin, and C#
- Add nine pinned-repository truth manifests
- Create: `scripts/code-intelligence-batch-c.mjs`
- Create: `evals/code-intelligence/results/phase2-batch-c.json`
- Add focused Rust and Node tests

- [x] **Step 1: Add failing JVM/.NET fixtures**

Cover package/namespace declarations, imports/using aliases, classes/interfaces/records/data classes, inheritance and implementation, constructors, overload-safe call identities, annotations/attributes, extension methods where resolvable, Spring MVC/Boot, Ktor, ASP.NET controllers, and minimal APIs.

- [x] **Step 2: Add package, namespace, heritage, and typed receiver resolution**

Qualified identities include package/namespace, owner, member, and stable signature discriminator when overloads exist. Resolve only evidence-backed receiver types. Record ambiguity instead of choosing an arbitrary overload.

- [x] **Step 3: Add framework route extraction**

Combine annotation/attribute and configuration evidence. Normalize methods and paths without copying request bodies or controller source.

- [x] **Step 4: Run all nine pinned repositories and update exact matrix cells**

Record floors and failures independently for Java, Kotlin, and C#.

- [x] **Step 5: Verify and commit Batch C**

Commit: `feat: add jvm dotnet intelligence batch`

## Task 5: Complete Batch D C, C++, Swift, and Dart

**Files:**

- Modify the Rust extractor/resolver and provider graph mapping
- Add fixture truth for C, C++, Swift, and Dart
- Add twelve pinned-repository truth manifests
- Create: `scripts/code-intelligence-batch-d.mjs`
- Create: `evals/code-intelligence/results/phase2-batch-d.json`
- Add focused Rust and Node tests

- [x] **Step 1: Add failing native/mobile fixtures**

C/C++: translation units, headers/includes, macros only where structurally safe, functions, structs/classes, namespaces, methods, constructors, inheritance, and CMake/build entry targets without invented HTTP routes.

Swift: modules/imports, functions/types/protocols/extensions, protocol conformance, receiver calls, Vapor routes.

Dart: libraries/imports/exports/parts, functions/classes/mixins/extensions, receiver calls, Shelf routes, Flutter application entry points.

- [x] **Step 2: Implement includes/modules, protocols, and bounded ambiguity**

Header relationships remain include edges until evidence resolves ownership. C/C++ overload ambiguity is explicit. Swift protocols/extensions and Dart mixins/parts receive distinct normalized relationships.

- [x] **Step 3: Add supported framework and entry-point detection**

Vapor and Shelf routes require syntax-backed registrations. Flutter, C, and C++ expose application/build entry points and dependencies, not fabricated web framework support.

- [x] **Step 4: Run all twelve pinned repositories and update exact matrix cells**

- [x] **Step 5: Verify and commit Batch D**

Commit: `feat: add native mobile intelligence batch`

## Task 6: Complete Batch E PHP and Ruby

**Files:**

- Modify the Rust extractor/resolver and provider graph mapping
- Add fixture truth for PHP and Ruby
- Add six pinned-repository truth manifests
- Create: `scripts/code-intelligence-batch-e.mjs`
- Create: `evals/code-intelligence/results/phase2-batch-e.json`
- Add focused Rust and Node tests

- [x] **Step 1: Add failing dynamic-language fixtures**

PHP: namespaces, `use` aliases, includes, functions/classes/interfaces/traits, inheritance/implementation, typed receivers, Laravel and Symfony routes.

Ruby: require/load paths, modules/classes/mixins, methods, inheritance, receiver calls with bounded confidence, Rails routes/controllers.

- [x] **Step 2: Implement namespace/convention resolution and dynamic confidence**

Use explicit types, constructors, imports, owners, and framework configuration before convention. Dynamic dispatch without evidence remains unresolved or inferred; it cannot count toward resolved-call precision.

- [x] **Step 3: Add Laravel, Symfony, and Rails structure**

Framework evidence joins route configuration/DSL registration to a handler locator. Do not mark controller-name string matches as exact handlers without configuration or syntax evidence.

- [x] **Step 4: Run all six pinned repositories and update exact matrix cells**

- [x] **Step 5: Verify and commit Batch E**

Commit: `feat: add php ruby intelligence batch`

## Task 7: Run the complete 42-repository Tier 1 audit

**Files:**

- Create: `scripts/code-intelligence-phase2-tier1.mjs`
- Create: `evals/code-intelligence/results/phase2-tier1-summary.json`
- Modify: `evals/code-intelligence/capability-matrix.v1.json`
- Modify: `docs/usage/code-intelligence-support.md`
- Modify: `docs/usage/support-matrix.md`
- Modify: `docs/benchmarks.md`
- Modify: `PROJECT_STATUS.json`
- Modify: `CHANGELOG.md`
- Modify generated release evidence

- [x] **Step 1: Aggregate without averaging away failures**

The summary lists every fixture and repository result. Per-language status uses the worst applicable required capability, not a macro average. A single nondeterministic case, repository failure, duplicate canonical symbol, or missing real-repository truth blocks `meets-floor` for that capability.

- [x] **Step 2: Verify safety and bounded resource behavior**

Record platform, engine/protocol version, exact commits/scopes, bounds, wall time, peak RSS where measurable, response bytes, graph counts, and write/network/model/memory safeguards. Reports contain hashes and counts, not raw output or paths.

- [x] **Step 3: Update public support language from the evidence only**

Name exact per-language values. Do not describe all fourteen as supported unless every required row passes. Keep npm binary availability, default-engine, MCP, web, multi-repo, scale, semantic search, communities, and process limitations explicit.

- [x] **Step 4: Verify and commit the Tier 1 audit**

Commit: `test: record tier one language evidence`

## Task 8: Close Phase 2 without promoting the runtime default

**Files:**

- Modify: `HANDOFF_VERIFICATION.json`
- Modify: `REPOSITORY_MANIFEST.json`
- Modify: generated release evidence
- Modify: this plan

- [x] **Step 1: Run every batch check plus the complete repository gate**

```bash
npm run check
npm run protocol:validate
npm test
npm run eval
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo test --manifest-path rust/Cargo.toml
node scripts/native-code-intelligence-consumer-smoke.mjs
node scripts/code-intelligence-phase1-compatibility.mjs --check
node scripts/code-intelligence-batch-a.mjs --check
node scripts/code-intelligence-batch-b.mjs --check
node scripts/code-intelligence-batch-c.mjs --check
node scripts/code-intelligence-batch-d.mjs --check
node scripts/code-intelligence-batch-e.mjs --check
node scripts/code-intelligence-phase2-tier1.mjs --check
npm run verify:handoff
npm run release:readiness:check
git diff --check
```

- [x] **Step 2: Verify claims and defaults**

Assert that default graph and all MCP reads still select JS, native remains preview-only, npm bundles no native binary, no non-evidenced language cell says `meets-floor`, competitor status remains unmeasured, and no parity/leadership claim exists.

- [x] **Step 3: Commit and verify a clean Phase 2 boundary**

Commit: `docs: close polyglot phase two`

Run: `git status --short --branch && git log -16 --oneline`

## Rollback

Each batch is additive and native remains opt-in. Revert the failing batch commit and its evidence/matrix changes. The public JS graph and MCP behavior remain available. Derived benchmark checkouts live in temporary directories and are deleted; no canonical memory or persistent public index is changed.

## Phase 3 handoff

Phase 3 begins only after Phase 2 has a truthful per-language matrix and a clean full gate. It moves the proven normalized graph into a new persistent SQLite index with incremental generations, dependency invalidation, watcher bounds, migrations, and corruption recovery. Phase 3 does not revisit failed language claims by relabeling them; unresolved Phase 2 gaps remain explicit work.
