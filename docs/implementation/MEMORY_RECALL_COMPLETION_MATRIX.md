# Memory Recall completion matrix

Snapshot date: 2026-07-18

Branch: `codex/memory-recall-orientation-workbench`

Initial matrix commit: `dc8fb91`

Current evidence commit: `dae56c28e2a44c158c03a0019d89a2ca7596e1dd`

Public registry rechecked 2026-07-18: `memory-recall@1.1.0`; all five `@memory-recall/native-*` packages returned npm `E404`.

This is the controlling proof ledger for the polyglot code-intelligence and stable-release goal. A green narrow test does not close a broader row. The original completion criteria remain unchanged.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| Proven | Current authoritative evidence covers the full stated row. |
| Incomplete | Some implementation or proof exists, but the full row is not established. |
| Contradicted | Current implementation or external state conflicts with the requirement. |
| Missing | No authoritative implementation or proof was found. |

## Release identity and semantic version

| ID | Requirement | Status | Authoritative evidence | Required closure |
| --- | --- | --- | --- | --- |
| V-1 | Ship one normal stable release, not a beta, preview, RC, or partial package. | Incomplete | `package.json` says `1.1.1`; `PROJECT_STATUS.json` and release documents still call it a patch candidate/readiness artifact; no release is authorized. The compatibility audit rejects a patch and does not choose a replacement version. | Freeze the implementation, re-run the compatibility audit against the exact root tarball, choose the stable line, and pass every final gate before publication. |
| V-2 | Do not treat the approximately 89,000-line expansion as an assumed patch. | Contradicted | `main...dae56c2` changes 351 files with 94,980 insertions and 2,597 deletions. The published baseline is `1.1.0`, while the worktree remains labeled `1.1.1`. `MEMORY_RECALL_SEMVER_COMPATIBILITY_AUDIT.md` identifies breaking distribution, MCP-config, Recall Map wire, default-engine, and shipped Rust-source contracts. | Restore or dual-serve every break before considering a minor line; otherwise use a major stable line after freeze. Do not choose or change the version yet. |
| V-3 | Preserve the exact original completion criteria. | Proven | This matrix maps the approved polyglot design, the active goal, and the ten stable-release priorities without redefining success. | Keep this ledger current after each slice. |

## Product target

| ID | Requirement | Status | Authoritative evidence | Required closure |
| --- | --- | --- | --- | --- |
| T-1 | Replace GitNexus for developer and coding-agent workflows. | Missing | `evals/code-intelligence/results/phase2-tier1-summary.json` explicitly denies parity; the Phase 8 test uses a fake GitNexus executable and one Go fixture. | Run identical pinned-corpus task and performance comparisons against the real permitted GitNexus artifact and file baselines. |
| T-2 | Meet or beat GitNexus across the fourteen Tier 1 languages. | Incomplete | Phase 2 has 14 fixtures and 43 repositories. Of 154 capability rows, 71 meet the sampled floor, 82 applicable rows are unmeasured, and one row is explicitly not applicable. | Resolve every applicable row with fixture and capability-specific evidence from at least three pinned repositories per language. |
| T-3 | Promote extra languages only after equal gates. | Proven | `PROJECT_STATUS.json` and `docs/usage/code-intelligence-support.md` keep Lua, Bash, SQL, Objective-C, Scala, R, Julia, and Zig experimental. | Do not promote them until the Tier 1 gate is closed and equivalent evidence exists. |
| T-4 | Keep installation to `npm install -g memory-recall` without Cargo or rustc. | Incomplete | `scripts/native-code-intelligence-consumer-smoke.mjs` proves the packed root plus native tarball on darwin-arm64; the other four platforms and registry install are unproven. | Pass clean packed and registry-shaped installs on all five targets with Cargo/rustc absent. |

## Architecture and invariants

| ID | Requirement | Status | Authoritative evidence | Required closure |
| --- | --- | --- | --- | --- |
| A-1 | Rust owns production code intelligence; Node owns transport, validation, memory, CLI, MCP, API, and UI. | Incomplete | ADR 0023 defines the boundary; Rust powers explicit/current native indexes. JS/TS fallback remains in `packages/source-graph`, and web defaults remain Node-based. | Make packaged Rust the verified default across CLI, MCP, Control API, and web, then delete the duplicate JS intelligence implementation and duplicate tests. |
| A-2 | Use one versioned provider-neutral graph and index schema. | Proven | `packages/protocol/schemas/code-intelligence-graph.schema.json`, index request/response schemas, provider wrapper, protocol validation, and compatibility tests. | Preserve schema compatibility through the final version audit. |
| A-3 | Use a persistent incremental embedded index; JSON is bounded export/debug output only. | Incomplete | Phase 3 proves SQLite generations and bounded incremental refresh over 781 files. JS JSON fallback remains a runtime path. | Promote SQLite-backed Rust reads everywhere and remove JSON as a production intelligence store. |
| A-4 | Persist content hashes and handle changed, added, deleted, and renamed files. | Incomplete | Rust index refresh and focused tests prove changed/added/deleted invalidation; exact rename behavior is not separately evidenced in the current receipts. | Add one rename regression proving identity/history behavior and refresh equivalence. |
| A-5 | Dependency invalidation is bounded and correct. | Proven | Phase 3 dependency-closure refresh receipt and Rust index tests pass with zero unresolved/omitted rows in the measured cases. | Revalidate at the large-repository gate. |
| A-6 | Bounded watch mode works reliably. | Incomplete | Watcher coordination exists and focused tests pass; no cross-platform, crash, or large-repository watcher gate is recorded. | Prove debounce, concurrent changes, deletion/rename, restart, and all supported platforms. |
| A-7 | Index migrations and corruption recovery are safe. | Incomplete | SQLite migrations, doctor, and repair exist with focused tests. Packaged cross-version migration, downgrade, and corrupt-index recovery are not proven on all targets. | Add packaged prior-version migration, corruption, repair, downgrade refusal/rollback, and clean reinstall gates. |
| A-8 | Freshness is explicit and reads fail closed. | Proven | Native status hashes current source scope; MCP auto uses only healthy current committed generations and emits reason-labeled fallback otherwise. | Preserve the behavior when Rust becomes the only production intelligence path. |
| A-9 | Multi-repository indexes load lazily and remain bounded. | Incomplete | The Rust SQLite registry supports up to eight indexes and one exact Go path; general lazy multi-repo behavior is not measured. | Prove independent repositories, bounded lazy opening/eviction, workspace isolation, mixed languages, and failure recovery. |
| A-10 | Preserve local-first operation, workspace isolation, provenance, read-only MCP, no silent cloud fallback, and reviewed semantic memory. | Proven | Protocol schemas, 12-tool MCP tests, governed-memory tests, Phase 0-5 safeguards, and project defaults report zero model/network/canonical-memory writes for structural reads. | Re-run security and packed-product gates after the production-default cutover. |

## Stable distribution chain

| ID | Requirement | Status | Authoritative evidence | Required closure |
| --- | --- | --- | --- | --- |
| D-1 | Publish all five native packages before the root package. | Incomplete | The local Rust workflow now aggregates exactly five attested packages; the npm workflow publishes them in fixed order, verifies npm integrity, and reaches root publication only afterward. No remote run or publication is authorized or proven. | Run the exact five-target workflow at the frozen commit and prove the protected publication lane without bypass. |
| D-2 | No root package may reference unpublished native packages. | Incomplete | Root `optionalDependencies` still references five `@memory-recall/native-*@1.1.1` packages that currently return npm `E404`. The workflow and the exported/direct root publisher now require the exact signed five-package native artifact directory, validate one version and commit, and re-verify registry integrity, provenance, and npm signature audit immediately before any root lookup or publication. The local guard passes; no remote protected run or registry proof exists. | Prove the same fail-closed guard in the remote protected workflow and publish no root until all five native packages pass it. |
| D-3 | Root installation works without a Rust toolchain. | Incomplete | An isolated Darwin-arm64 lifecycle installs the single prepacked root tarball and its matching native tarball without Cargo/rustc, validates the installed package paths, exercises CLI and MCP, uninstalls, and reinstalls the same artifacts. Four platform lanes and registry installation remain unproven. | Run the identical consumer smoke on all five native runners using the exact release artifacts. |
| D-4 | Validate target OS, CPU, libc, binary version, and exact package contents. | Incomplete | `.github/workflows/rust.yml` defines five runner identities and validates tarball contents; only darwin-arm64 has a retained local receipt. | Obtain successful retained receipts from all five GitHub matrix jobs at the frozen commit. |
| D-5 | Verify binary and tarball checksums. | Incomplete | Native manifests and receipts carry SHA-256; the aggregate validator binds the exact tarball hash and npm integrity for all five packages before publication. Four remote receipts are missing. | Obtain and verify the complete frozen-commit artifact set from all five runners. |
| D-6 | Produce complete native provenance and SBOM. | Incomplete | The local workflow produces file-complete SPDX 2.3 documents for each native target and the exact root tarball, with SHA-1/SHA-256 file checksums, package verification codes, tarball checksums, and version-qualified namespaces. The workflow binds both artifact classes to signed SBOM predicates. No remote attestation set exists. | Obtain and verify all root and native provenance and SBOM attestations from one successful frozen-commit run. |
| D-7 | Sign supported native artifacts. | Incomplete | The local workflow uses `actions/attest@v4`; both the Rust aggregate and npm consumer verify exact repository, signer workflow, signer/source commit, and hosted runner. Remote attestations and any required platform code-signing proof remain absent. | Run the protected five-platform producer, retain the cryptographic attestations, and document whether macOS/Windows platform signing is additionally required. |
| D-8 | Prove uninstall and clean reinstall. | Incomplete | The isolated Darwin-arm64 exact-artifact lifecycle proves MCP entry removal, neighboring-config preservation, package removal, workspace-state preservation, and same-version clean reinstall that reopens the existing index without rebuilding. | Repeat on all five targets and add cross-version upgrade, downgrade-refusal, and rollback cases. |
| D-9 | Publish checksums, provenance, and SBOM with the stable release. | Incomplete | The protected workflow packs the root exactly once, records SHA-256 and SHA-512 integrity, uploads that artifact, attests its provenance and complete SPDX predicate, and later publishes those exact bytes. Registry verification requires exact root integrity plus both npm publish and SLSA predicates after the five equivalent native verifications. No remote evidence or authorized stable release exists. | Run the protected workflow at the frozen commit, retain the root and native evidence set, and attach it only during the authorized stable release. |

## Fourteen-language support gate

Phase 2 currently reports 71 `meets-floor` rows, 82 applicable `unmeasured` rows, and one explicit `not-applicable` row. No row is recorded as `does-not-meet-floor`, which means missing proof must not be relabeled as support.

| ID | Requirement | Status | Authoritative evidence | Required closure |
| --- | --- | --- | --- | --- |
| L-1 | At least three pinned repositories exist for every Tier 1 language. | Proven | `evals/code-intelligence/corpus.v1.json` contains 43 pinned repositories; the corpus gate passes for all fourteen languages. | Preserve exact commits and source hashes in final comparison runs. |
| L-2 | Declarations and structural symbols meet recall floors. | Incomplete | All languages have sampled declaration evidence, but capability coverage remains uneven and partial scopes exist. | Expand reviewed declarations per capability and keep recall at or above 95% for every language. |
| L-3 | Packages, modules, imports, exports, and bindings resolve exactly. | Incomplete | All fourteen Tier 1 import rows meet the sampled floor. Go exports preserve specification-defined public identifiers; Rust exports preserve public visibility and re-export targets; Dart URI-level module re-exports preserve full coordinates and resolve local relative or self-package targets when scanning a package root or its `lib` directory. Each has fixture plus three-repository evidence. Nine export rows, Dart `show`/`hide`, broader Dart monorepo-root package discovery, and broader binding behavior remain unmeasured. | Add fixture plus three-repository truth for every remaining applicable package/export/binding row. |
| L-4 | Cross-file resolution is exact and source-backed. | Incomplete | Selected language fixtures and Phase 3 dependency cases pass; no all-language capability gate exists. | Prove cross-file positive, negative, same-name decoy, and unresolved diagnostics per language. |
| L-5 | Heritage, interfaces, traits, and protocols resolve. | Incomplete | Python and selected languages have sampled heritage; most heritage rows are unmeasured. | Add reviewed heritage truth for every applicable language and explicit not-applicable decisions where the language lacks the construct. |
| L-6 | Type and receiver inference resolves calls correctly. | Incomplete | TS and Python have reviewed inference evidence; several language type/call rows remain unmeasured. | Prove same-name receiver disambiguation and confidence for every applicable Tier 1 language. |
| L-7 | Calls meet at least 90% reviewed precision with confidence evidence. | Incomplete | Phase 2 sampled call precision passes where measured. Dart includes a typed Flutter call and a same-name wrong-callsite decoy. Kotlin includes fixture plus three-repository callsite-owner evidence and rejects a wrong-caller decoy, while the sampled target remains unresolved. Swift and several other call/type combinations remain unmeasured or governed-memory-limited. | Add reviewed positive/negative calls and confidence strategies per remaining language without weakening identity safety. |
| L-8 | Entry points are detected for applicable applications and frameworks. | Incomplete | Selected fixtures expose `entry_point`; there is no capability row or three-repository gate per language. | Define applicability and prove real entry points or explicit not-applicable results. |
| L-9 | Framework routes are detected without documentation/example false positives. | Incomplete | Python FastAPI, Flask, and Django meet a narrow reviewed floor; other applicable language/framework rows are unmeasured. | Add framework-specific truth for applicable languages and explicit unsupported diagnostics elsewhere. |
| L-10 | Configuration resources and build/package manifests are modeled. | Incomplete | Python config is measured; most config rows are unmeasured. | Define per-language applicability and add reviewed manifest/config truth. |
| L-11 | Impact is correct for each language. | Incomplete | Phase 4 now runs bounded impact probes on exact pinned JavaScript, TypeScript, and Go repositories, and Phase 5 proves one Go path. These are evidence-bearing probes, not reviewed impact truth across fourteen languages; Phase 2 impact rows remain unmeasured. | Prove forward/reverse impact with evidence and decoys on three repositories per applicable language. |
| L-12 | Search, context, trace, dependencies, and processes work for each language. | Incomplete | Native provider and MCP contracts exist. Phase 4 runs the workflow families on exact pinned Express, Nest cats-sample, and Gin scopes in addition to the four-file fixture. Eleven languages and task-level truth remain open, and three repositories total do not satisfy the per-language corpus gate. | Run the full workflow set on the per-language pinned corpus with bounded outputs and task-level truth. |
| L-13 | Results are deterministic and contain no duplicate canonical symbols. | Incomplete | Phase 2 sampled graphs are deterministic with zero recorded duplicates; five repository scopes report omissions and 82 applicable capability rows remain unmeasured. | Re-run determinism/duplicate checks for every completed capability and final packaged binaries. |
| L-14 | Partial, unsupported, and not-applicable behavior is explicit. | Incomplete | Tier 1 applicability is now independent of evidence presence. All applicable unsupported or missing rows remain non-green; C heritage is the sole explicit not-applicable row with a language-semantic rationale. Eighty-two applicable rows remain unmeasured. | Prove or explicitly fail every remaining applicable row without converting missing evidence into not-applicable support. |

### Current unmeasured rows

| Language | Unmeasured | Capabilities |
| --- | ---: | --- |
| TypeScript | 5 | heritage, config, frameworks, impact, processes |
| JavaScript | 5 | heritage, config, frameworks, impact, processes |
| Python | 3 | exports, impact, processes |
| Java | 7 | exports, heritage, types, config, frameworks, impact, processes |
| Kotlin | 7 | exports, heritage, types, config, frameworks, impact, processes |
| C# | 7 | exports, heritage, types, config, frameworks, impact, processes |
| Go | 6 | heritage, types, config, frameworks, impact, processes |
| Rust | 5 | heritage, config, frameworks, impact, processes |
| PHP | 6 | exports, types, config, frameworks, impact, processes |
| Ruby | 7 | exports, heritage, types, config, frameworks, impact, processes |
| Swift | 6 | exports, calls, config, frameworks, impact, processes |
| C | 6 | exports, types, config, frameworks, impact, processes |
| C++ | 7 | exports, heritage, types, config, frameworks, impact, processes |
| Dart | 5 | heritage, config, frameworks, impact, processes |

## Phase 4 intelligence

| ID | Requirement | Status | Authoritative evidence | Required closure |
| --- | --- | --- | --- | --- |
| I-1 | Deterministic communities on real repositories. | Incomplete | The current Phase 4 receipt runs `label-propagation-v1` five times on exact pinned Express, Nest cats-sample, and Gin scopes (260 files, 4,564 nodes, 13,640 edges combined), records deterministic results, and proves two non-overlapping cursor pages for every repository. It does not contain reviewed community truth or large-repository stability evidence. | Add reviewed community truth and stability metrics on representative pinned repositories and large repos. |
| I-2 | Bounded entry-to-sink processes on real repositories. | Incomplete | All three exact repositories return deterministic `entry-path-v1` processes with at least two nodes, canonical relationship evidence, confidence of at least 0.75, continuous pagination, and p95 latency below the two-second deadline. The receipt has no reviewed process ground truth and does not cover cycles, incomplete paths, varied sinks, or representative language breadth. | Prove correct complete/incomplete paths, multiple entries/sinks, cycles, depth bounds, and language coverage on real repositories. |
| I-3 | Hybrid local search. | Incomplete | Native exact, lexical, and one-hop structural search passes the local fixture. Search is deterministic on Express, Nest, and Gin; each result has a workspace locator, all p95 values are below 74 ms, and receipts record delivered bytes/token estimates plus continuation where present. There is no reviewed relevance set, MRR/recall result, lexical-only comparison, or exact tokenizer measurement. | Add reviewed query sets, MRR/recall, lexical-only baseline, exercised search continuation, and exact delivered-token measurements on representative real repositories. |
| I-4 | Routes, impact, dependencies, trace, and safe graph queries. | Incomplete | All three exact repositories run every query family deterministically under the two-second deadline. Dependencies, safe query, and trace must traverse at least one real relationship; every returned relationship carries canonical endpoints, locator evidence, and confidence. Generic seeds and the absence of reviewed positive/negative truth prevent a correctness claim. | Add identical real-repository queries with reviewed positive/negative truth, decoys, and deadlines across representative languages. |
| I-5 | Evidence, confidence, pagination, token accounting, and deadlines. | Incomplete | The fixture proves relationship evidence, confidence propagation, and read queries preserving its SQLite bundle. All three real-repository runs prove located results, evidence-complete relationships, process evidence, community/process cursor continuity, per-query byte/token estimates, and two-second deadlines. Exact token accounting, token budgets, truncation truth, cancellation, and pagination for every query family remain unproven. | Add exact delivered-token accounting, budgets, truncation/cancellation cases, and continuation tests per query family. |
| I-6 | Preserve exactly twelve MCP tools unless a distinct capability requires another. | Proven | MCP inventory and packed consumer smoke verify twelve read-only tools. Phase 4/5 reuse those tools. | Keep the inventory stable through final packaging. |

## Phase 5 multi-repository and cross-service intelligence

| ID | Requirement | Status | Authoritative evidence | Required closure |
| --- | --- | --- | --- | --- |
| M-1 | General multi-repository search and traversal. | Incomplete | Registry search opens up to eight indexes; only one exact two-repository Go module path is measured. | Prove multiple independent repositories, mixed languages, ambiguous names, missing repos, and bounded partial results. |
| M-2 | Evidence-backed cross-repository and cross-service relationships. | Incomplete | One Go import/call/trace/impact path and one monorepo two-prefix fixture pass with decoy rejection. | Add general package coordinates, services, routes, data flow, reverse impact, and cross-language cases. |
| M-3 | Preserve repository/workspace isolation. | Incomplete | Current registry and provider tests cover selected isolation cases. | Add unauthorized repository IDs, stale/missing indexes, concurrent registries, and packaged consumer isolation. |

## Scale and performance

| ID | Requirement | Status | Authoritative evidence | Required closure |
| --- | --- | --- | --- | --- |
| S-1 | Index exactly one million committed nodes within the measured gate. | Contradicted | `million-node-rust-index.json` timed out after 305,016 ms with SIGKILL and no committed counts. | Profile the cold build, identify the measured bottleneck, optimize it, and keep the existing timeout. |
| S-2 | Warm open, no-change refresh, one-file refresh, and exact query work on the million-node index. | Missing | All were skipped or failed because the cold build failed. | Run only after cold build succeeds; record RSS, database bytes, latency distributions, correctness, and determinism. |
| S-3 | Optimize only measured bottlenecks. | Proven | Previous changes removed a quadratic decorator scan, reduced conversion memory, and deduplicated node lookup; the current timeout remains explicit. | Capture a fresh profile before the next optimization and do not raise the deadline. |

## Production default and duplicate deletion

| ID | Requirement | Status | Authoritative evidence | Required closure |
| --- | --- | --- | --- | --- |
| P-1 | Packaged Rust is the production default in CLI. | Incomplete | Installed-package commands prefer verified native reads when a current index exists, but fallback remains available and first-run indexing is not the universal default. | Prove clean first-run indexing and every CLI structural workflow from the packed product. |
| P-2 | Packaged Rust is the production default in MCP. | Incomplete | MCP `auto` selects only a current verified native index and otherwise uses a labeled JS fallback. | Make the packaged native lifecycle available on first run and prove all twelve tools without JS intelligence. |
| P-3 | Packaged Rust is the production default in web/Control API. | Incomplete | Web can read native index data, while support docs still state the workbench uses Node source-graph services by default. | Route all structural web/API reads through the same native index and prove failure/recovery states. |
| P-4 | Delete duplicate JS intelligence and duplicate tests after default cutover. | Incomplete | JS fallback is intentionally frozen but still present. | Delete only after P-1 through P-3 and packed cross-platform gates pass. |

## Large-repository UI

| ID | Requirement | Status | Authoritative evidence | Required closure |
| --- | --- | --- | --- | --- |
| U-1 | First screen explains shape, coverage, subsystems, entry points, hotspots, changes, memory, and next action. | Incomplete | Orientation models and browser tests cover the local workbench; not every item is proven on a large polyglot repository through the packaged native path. | Run task-based browser proof on representative large repositories and correct comprehension gaps. |
| U-2 | Map uses progressive disclosure for groups, communities, processes, neighborhoods, and evidence. | Incomplete | Focused canvas, readable outline, and processes exist; large-repository communities/groups and progressive interaction remain unproven. | Prove density controls, selection, zoom/fit, outline parity, keyboard operation, and evidence drill-down on large graphs. |
| U-3 | Navigation is understandable and Map works directly. | Incomplete | Route and navbar tests exist; prior user observation showed Map discoverability and Run Map behavior were confusing. | Browser-test first-run navigation and direct Map execution with users' likely first actions. |
| U-4 | No overlap or unreadable source-map outline. | Incomplete | Focused layout and outline regressions exist; no current full visual audit across representative large repos and viewports is recorded. | Capture desktop/mobile screenshots and test long labels, narrow inspectors, zoom, overflow, and selection. |
| U-5 | Desktop, mobile, accessibility, overflow, and every control pass in a real browser. | Incomplete | Consumer browser smoke covers selected routes and mobile overflow. It is not the complete native large-repository control inventory. | Click every interactive control at desktop/mobile widths; run accessibility and console-error checks. |
| U-6 | Complete the anti-slop review before UI completion. | Missing | Design rules and anti-template tests exist, but no point-by-point final review artifact covers the current full UI. | Perform the complete review after functionality freezes and record every applicable pass/fix. |

## Head-to-head proof

| ID | Requirement | Status | Authoritative evidence | Required closure |
| --- | --- | --- | --- | --- |
| H-1 | Run identical pinned commits through Memory Recall, GitNexus, and file baselines. | Missing | The Phase 8 runner covers one Go fixture and the automated test substitutes a fake GitNexus executable. | Use the real permitted GitNexus artifact and the full pinned Tier 1 corpus with immutable versions/hashes. |
| H-2 | Measure structural, search, and task accuracy. | Missing | Memory Recall truth exists; there is no complete identical-product comparison report. | Define identical reviewed questions and compute recall, precision, MRR, task success, and unsupported cases. |
| H-3 | Measure indexing, latency, RSS, disk, MCP calls, and delivered tokens. | Missing | Separate local Memory Recall receipts exist; competitor/file measurements are absent. | Capture all metrics under identical limits and hardware, including warm/cold behavior and confidence intervals. |
| H-4 | Meet floors: symbol recall at least 95%, resolved-call precision at least 90%, zero duplicate symbols, determinism, explicit unsupported states, and real-repository proof. | Incomplete | Sampled Memory Recall rows meet floors where measured; 82 applicable rows and competitor runs are missing. | Close all applicability rows and execute the full comparison. |
| H-5 | Claim parity or leadership only from proven results. | Proven | Current receipts explicitly set parity and leadership false. | Keep claims false until H-1 through H-4 pass. |

## Phase status

| Phase | Requirement | Status | Evidence and remaining boundary |
| --- | --- | --- | --- |
| 0 | Matrix, ADR, schema, baseline. | Proven | ADR 0023, provider-neutral schemas, corpus, gates, and six-command baseline pass. |
| 1 | Unify Node and Rust. | Incomplete | Protocol/provider bridge exists; production still has duplicate JS intelligence and divergent defaults. |
| 2 | Pass fourteen Tier 1 languages. | Incomplete | 71/154 rows meet floor; 82 applicable rows remain unmeasured and one row is not applicable. All fourteen language-level statuses remain unmeasured. |
| 3 | Scalable index, watcher, and recovery. | Incomplete | Core SQLite lifecycle passes; cross-platform packaged migration/recovery and million-node scale do not. |
| 4 | Search, communities, processes, routes, impact, query, and MCP. | Incomplete | The deterministic fixture and exact pinned Express, Nest cats-sample, and Gin slices pass, including evidence-backed relationship traversal, community/process pagination, all required query families, delivery estimates, and deadlines. The receipt explicitly keeps `phase4IntelligenceProven: false`; reviewed correctness, representative language breadth, large repositories, exact token budgets, cancellation, and full pagination remain missing. |
| 5 | Multi-repository and cross-service. | Incomplete | One Go cross-repo path and one monorepo fixture are insufficient. |
| 6 | Signed npm distribution. | Incomplete | The local producer/consumer chain is native-first, transports one exact root tarball, and verifies signed GitHub provenance, file-complete SPDX predicates, npm integrity, and root plus native npm attestation bundles. Remote five-platform proof and publication remain absent. |
| 7 | Polyglot large-repository UI. | Incomplete | Local UI slices exist; complete packaged native, large-repo, responsive, accessibility, and anti-slop gates are missing. |
| 8 | Head-to-head benchmark and audits. | Missing | Only a fake-competitor one-fixture harness test exists; no full comparison receipt exists. |
| 9 | Promote extra languages and formats. | Missing | Correctly deferred; no promotion gate has been run. |

## Final stable-release audit

| ID | Requirement | Status | Authoritative evidence | Required closure |
| --- | --- | --- | --- | --- |
| R-1 | Full Node CI on frozen implementation. | Incomplete | The current evidence slice passed 803 tests, 208 protocol fixtures, and 144 evaluations after the native resolver and receipt changes; implementation is not frozen. | Run once more only after all required implementation is complete. |
| R-2 | Full Rust workspace on frozen implementation. | Incomplete | The current evidence slice passed the full Rust workspace: 121 unit and integration tests plus all doc tests; implementation is not frozen. | Run at final freeze. |
| R-3 | All five platform package jobs. | Missing | Workflow matrix exists; only darwin-arm64 is locally proven. | Run the GitHub `Rust` workflow `native-artifacts` matrix at the exact frozen commit and retain all receipts. |
| R-4 | Security and CodeQL. | Incomplete | CodeQL workflow exists; no final frozen-commit result is recorded here. | Run CodeQL and security audit at the frozen commit and bind run URLs/SHAs to release evidence. |
| R-5 | Packed clean installs. | Incomplete | Darwin-arm64 root-plus-native smoke passes. | Pass all five platforms from clean HOME without Cargo/rustc. |
| R-6 | Complete browser suite. | Incomplete | Earlier browser slices passed locally; final packaged-native large-repository UI is not frozen. | Run the final control inventory, accessibility, responsive, overlap, and overflow suite. |
| R-7 | Release readiness and handoff verification. | Incomplete | Current generated documents validate locally but describe an unfinished patch candidate and omit native artifact provenance. | Regenerate and verify only after the stable implementation and distribution artifacts are frozen. |
| R-8 | Do not push, merge, publish, or deploy without separate authorization. | Proven | All current work is local on `codex/memory-recall-orientation-workbench`; no remote mutation was performed in this goal continuation. | Report exact branch, commit, GitHub action, and publication order when local work is ready. |

## Fastest dependency order

1. Keep the local root-plus-five-native artifact chain guarded; defer its remote five-platform run until the implementation is frozen.
2. Close the 82 applicable language rows without weakening gates.
3. Finish reviewed Phase 4 correctness on real repositories, then general Phase 5.
4. Profile and fix the million-node cold build within the existing timeout.
5. Promote packaged Rust across CLI/MCP/API/web; delete JS intelligence only after proof.
6. Complete the large-repository browser and anti-slop gates.
7. Run the real identical-corpus comparison.
8. Freeze implementation, re-run this semantic-version audit against the exact tarball, choose the stable version, obtain five platform receipts, run final audits, and only then request publication authorization.
