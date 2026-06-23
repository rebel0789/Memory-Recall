# Reference Tools Native Context And Memory Master Plan

Date: 2026-06-23
Status: proposed
Scope: research-backed design plan for post OAF-031 native context, memory,
graph, token-efficiency, and harness setup work.

This plan is intentionally not an implementation handoff. It records what OAF
should build after source-level audits of adjacent projects, and what must stay
out of the default product until explicit adapter review and approval exists.

## Stop Line

Do not implement this plan until maintainers approve the design. The current
OAF-031 branch already has a dry-run harness context preview and benchmark
slice. This plan defines the next native work.

## Current OAF Boundary

OAF is the local-first reliability and context control plane. Its native value
is:

- context manifests with selected and excluded reasons;
- proposal-only memory lifecycle;
- deterministic policy, approvals, and grants;
- evented runs and side-effect-free replay;
- provider-neutral schemas and conformance gates;
- disabled external adapters by default.

External tools can be references, eval comparators, or disabled adapters. They
must not become canonical policy, memory, event, model, source, graph, or
artifact state.

## Audit Inputs

Reference clones were placed under `/tmp/oaf-reference-audit-6Xu6k7`. The
product repository was not edited during source audits.

| Reference | Audited commit | License signal | What OAF should learn | What OAF must not copy into core |
| --- | --- | --- | --- | --- |
| `zzet/gortex` | `5062fdc8a04083be783cb0f0e0ceaea2f48506e1` | Apache-2.0 | graph-backed code context, graded context tiers, token/latency/recall benchmark discipline, tool catalog deferral | mutating file tools, hook enforcement, direct durable memory writes, fail-open presets, graph superiority claims without OAF benchmarks |
| `safishamsi/graphify` | `a4d09aefd8fc441c98db8203440602350a8d75ae` | MIT | derived source graph, confidence labels, bounded subgraph selection, incremental replacement by content hash | URL/media ingestion, external LLM extraction, Neo4j/FalkorDB writes, global graph state, mandatory agent hooks |
| `oraios/serena` | `dd7eb6d72ae179aa940e50cd6276ec5646f306f8` | MIT | local semantic symbol source, LSP-style definitions/references, memory reference checks, read-only planning modes | shell execution, auto language-server downloads, direct edits, telemetry, Markdown memory as authority |
| `mex-memory/mex` | `c341ee7301dea6f5990336f69fc84d9ceef2fa06` | MIT | project scaffold conventions, drift detection, source-grounded remediation briefs, append-only local decisions | opt-out telemetry, git hooks, external AI CLI repair loops, unvalidated scaffold authority |
| `supermemoryai/supermemory` | `f28e974609112696057924881a60bff2fe515ba6` | MIT plus mixed package notices | memory lifecycle fields, static/dynamic profile views, namespace discipline, graph/version UI fixtures | hosted memory as native store, automatic memory writes, browser cookie/header capture, opaque rerank authority |
| Supermemory harness plugins | see source audit notes | mostly MIT; `claude-supermemory` lacks a clear package license | host lifecycle fixtures for Codex, Claude, Cursor, OpenCode, OpenClaw; non-destructive merge/unmerge ideas | automatic transcript upload, project API-key files, auto-approved searches, hidden prompt injection, OpenCode compaction mutation |
| `supermemoryai/memorybench` | `118209a746d97d0d85e5a7234267f0b6962857e9` | MIT | phase-separated evals, checkpoint/resume, provider comparison reports, latency/token/quality separation | hosted defaults, unseeded sampling, runtime dataset downloads without checksums, LLM-judged retrieval as merge gate |
| `supermemoryai/code-chunk` | `fca495ade31ed09a293a8fea4427953cc8bfab62` | MIT | AST-window candidate generation, exact source ranges, scope/entity/import metadata | Bun/Effect dependency surface, URL-loaded WASM, networked SWE-bench eval stack, character-counts-as-token claims |
| `supermemoryai/smfs` | `f4a0f5034431638d66f8c350408f34bb5b8cbce5` | MIT | filesystem-native memory UX, SQLite queue, dirty watermarks, latest-write coalescing, poison/error records | Supermemory sync, shell grep hijacking, plaintext API key path, FUSE/NFS bootstrap dependency, remote writes |
| `supermemoryai/llm-bridge` | `9ebb7c70336cf4db9c1ede73a2a049d7523e58c3` | MIT | provider translation fixtures, stream event edge cases, safe error taxonomy ideas | proxy handler, raw `_original` persistence, default-to-OpenAI detection, remote pricing fetch, silent schema weakening |
| `supermemoryai/install-mcp` | `c2a97fbbfc0dcfdbff0b4b4778b9ec1ba6a7ac7f` | MIT | client config matrix, JSON/JSONC/YAML/TOML install shapes | global config writes without preview, unpinned `mcp-remote@latest`, secret logging, parse-failure overwrite behavior |
| `supermemoryai/supermemory-mcp` | `84f5dc9f1cf077ba753decbf56805205b5c0443a` | MIT | simple MCP memory affordance and deprecation warning | automatic memory-write prompt, path secrets, CORS looseness, logging memories/API keys, no resource model |

## Design Direction

Build a native OAF context intelligence layer. It should make OAF better at
selecting small, useful, evidence-backed context while preserving the existing
authority model.

The design has five native pillars:

1. **Candidate sources:** exact, lexical, harness, AST code, symbol, graph, and
   memory candidates all normalize into OAF schemas before selection.
2. **Derived graph:** OAF can build a local derived graph over source records,
   memory proposals, evidence, manifests, tools, and decisions. The graph is an
   index, not canonical state.
3. **Token optimizer:** OAF chooses full text, compressed snippet, outline,
   locator-only, or exclusion per candidate. It records the reason and token
   cost in the context manifest.
4. **Proposal memory:** memory remains proposed, accepted, superseded,
   rejected, forgotten, or expired by OAF lifecycle rules. External memories are
   untrusted candidates.
5. **Harness bridge:** OAF can plan, preview, and eventually install read-only
   or proposal-only integrations for Codex, Claude, Cursor, OpenCode, OpenClaw,
   Gemini CLI, Zed, Aider, Goose, and other clients without touching real home
   config unless approval is explicit.

## Native Domain Model Additions

Add these as schema-first contracts before runtime behavior:

- `sourceContextCandidate`: file, AST chunk, symbol, graph node, memory, or
  harness item with locator, source hash, scope, data class, trust, confidence,
  and extraction method.
- `contextGraphNode`: `source`, `symbol`, `chunk`, `evidence`, `memory`,
  `manifest`, `decision`, `tool`, `agent-pack`, `harness-config`, or
  `benchmark-case`.
- `contextGraphEdge`: `defined_in`, `references`, `imports`, `calls`,
  `supports`, `conflicts_with`, `supersedes`, `selected_in`, `excluded_from`,
  `requires_policy`, `derived_from`, or `same_entity`.
- `contextCompressionDecision`: `full`, `snippet`, `outline`, `locator-only`,
  or `excluded`, with token estimate, reason, and loss notes.
- `memoryLifecycleLink`: `updates`, `extends`, `derives`, `supersedes`,
  `forgets`, `expires`, or `contradicts`.
- `harnessConfigPlan`: dry-run install/status/uninstall plan with redacted diff,
  side-effect class, target client, parser status, and rollback material.
- `translationLoss`: model/provider adapter field-level loss report for
  gateway translations.

No schema may include raw prompts, raw outputs, credentials, provider URLs,
private source bodies, local absolute paths, hidden reasoning, cookies, auth
headers, or API keys in public report fields.

## Implementation Phases

### Phase 1: Benchmark Lab 2

Before new source providers, add a deterministic benchmark suite with gold
evidence IDs and fixed fixtures.

Deliverables:

- benchmark dataset schema with `question`, `requiredEvidenceIds`,
  `distractorIds`, `forbiddenIds`, `workspaceId`, `expectedAnswer`, and
  `abstainWhenMissing`;
- phase-separated run artifacts: retrieval, context assembly, deterministic
  answer, judge, report;
- checkpoint/resume based on OAF events and manifest fingerprints;
- comparison report for exact, lexical, harness-preview, and future candidate
  sources.

Do not use hosted judges or LLM-judged retrieval for merge gates.

### Phase 2: Native AST Code Candidate Source

Start with JavaScript and TypeScript only.

Deliverables:

- `providers/native/context-candidate-ast-code/`;
- protocol schema for AST chunks with parser version, byte range, line range,
  scope chain, entities, imports, parse error state, and content hash;
- candidate source tests for malformed files, oversized files, parse errors,
  symlink escape, exact slice reconstruction, cache invalidation, and no
  network calls;
- Context Compiler eval comparing AST candidates against exact/lexical.

Do not add tree-sitter runtime dependencies without an ADR. If parser
dependencies are accepted later, pin them, document notices, and keep the
dependency-free bootstrap path intact.

### Phase 3: Native Derived Context Graph

Build a local derived graph index from normalized OAF records.

Deliverables:

- graph schema and fixtures;
- graph build from source candidates, evidence records, memory records,
  context manifests, tool manifests, Agent Packs, and benchmark cases;
- bounded subgraph selector that returns candidates to the Context Compiler;
- incremental rebuild by source content hash;
- graph diff between full rebuild and incremental rebuild.

Do not add Neo4j, FalkorDB, vector databases, embeddings, URL crawlers, media
transcription, or external LLM extraction to core.

### Phase 4: Token Optimizer And Manifest Deltas

Add compression tiers and delta-aware manifests.

Deliverables:

- context assembly tiers: full, snippet, outline, locator-only, excluded;
- manifest `etag` and `deltaFrom` fields for repeated tasks;
- explicit omission and compression reason codes;
- token budget report with selected-token ratio, wasted-token estimate,
  required evidence coverage, and compression loss notes.

Do not claim token superiority over Gortex, Graphify, Serena, or any external
tool until OAF benchmarks run against the same fixtures.

### Phase 5: Memory Lifecycle And Filesystem UX

Expose memory as local files and reports without making files authoritative.

Deliverables:

- workspace-local generated `memory/profile.md` derived from accepted OAF
  memory only;
- `memory/proposals/*.md` or JSON reports for pending proposals;
- explicit `memoryPaths` config used only as proposal sources;
- `oaf memory sgrep` for local source-grounded search returning lifecycle
  state, evidence IDs, and context manifest reason codes;
- SQLite queue pattern for local proposal writes and reconciliation, with
  poison/error records.

Do not hijack shell `grep`, mount FUSE/NFS in bootstrap, sync to Supermemory,
store API keys as core OAF credentials, or create active memory from ordinary
file edits.

### Phase 6: Harness Setup Planner

Turn the install-mcp and Supermemory plugin research into a safe OAF planner.

Deliverables:

- config matrix fixtures for Codex, Claude Code, Cursor, OpenCode, OpenClaw,
  Gemini CLI, Zed, Aider, Goose, VS Code, Cline, Roo, Windsurf, and related
  clients;
- `harness setup plan` with redacted diff only;
- `harness setup status` that fails closed on malformed config;
- `harness setup uninstall --dry-run` that removes exactly one named server;
- temp-home round-trip tests for JSON, JSONC, YAML, and TOML.

Applying real config writes is a consequential effect and must require exact
preview, approval, atomic write, backup, rollback, and event recording.

### Phase 7: Read-Only MCP Resources

Expose OAF state to harnesses through read-only MCP resources first.

Deliverables:

- resources for status, context manifests, benchmark reports, memory proposals,
  and handoff bundles;
- no memory writes, source snapshot writes, or external egress on resource read;
- schema-validated resource payloads with provenance and timestamps;
- contract tests for auth rejection, workspace isolation, prompt discovery,
  and resource read determinism.

Write tools can come later only with exact grants and policy approval.

### Phase 8: Disabled Shadow Adapters

Only after the native baselines pass should OAF add disabled shadow adapters for
comparison with external systems.

Possible adapter targets:

- Gortex as source graph candidate adapter;
- Graphify as derived graph candidate adapter;
- Serena as local symbol candidate adapter;
- Supermemory as memory provider adapter;
- MemoryBench-style external provider comparison.

Each adapter requires exact upstream commit, checksum, license review,
threat-model notes, conformance tests, default-disabled catalog state, offline
standard CI, and no canonical provider IDs in OAF domain state.

## Benchmark Gates

These are merge gates for the native work.

| Gate | Required result |
| --- | --- |
| Gold evidence retrieval | Recall@10 `>= 0.98`, MRR@10 `>= 0.85`, NDCG@10 `>= 0.90`, workspace leakage `0` |
| Context budget | required evidence recall `1.0`, distractor exclusion `>= 0.90`, selected token ratio `<= 0.50`, leakage counts `0` |
| AST boundary | exact slice reconstruction `>= 0.98`, no unmarked entity-boundary crossing, parser failure cannot abort context compile |
| AST token efficiency | median selected-token estimate improves `>= 25%` over exact/lexical baseline while oracle file/entity coverage does not regress |
| Graph correctness | incremental rebuild equals full rebuild for node/edge set, stale removed contributions `100%`, graph caps enforced |
| Memory lifecycle | active-current recall `>= 0.95`, superseded/expired selection `0`, abstention precision and recall `>= 0.95` |
| Harness capture hygiene | normal chat creates `0` permanent memory writes, secret/private/injected transcript leakage `0`, hook failures do not break host session |
| Config planner | all client fixtures produce deterministic dry-run diffs, malformed config fails closed, install/status/uninstall round-trip is idempotent |
| Read-only MCP | resource reads emit no canonical writes, no undeclared egress, schema validation passes, workspace isolation leaks `0` |
| Provider translation | all adapter translations validate OAF schemas; every stripped field is recorded in `translationLoss[]`; raw provider payloads are not persisted |
| Filesystem memory UX | zero network calls, zero external writes, queue recovers from forced crashes, no duplicate active logical record |
| Reproducibility | repeated runs and phase resumes produce identical dataset, checkpoint, manifest, and report fingerprints |

## Product Shape After Approval

The useful beta surface should be command-first and inspectable:

```bash
npm run oaf -- context preview --from all --root . --objective "..." --step "..." --dry-run
npm run oaf -- context graph preview --root . --query "..." --dry-run
npm run oaf -- memory proposals --from workspace --dry-run
npm run oaf -- memory sgrep "..." --workspace ws_local --dry-run
npm run oaf -- harness setup status --client codex --dry-run
npm run oaf -- harness setup plan --client cursor --server oaf --dry-run
npm run oaf -- mcp resources --read-only --stdio
```

The first public claim should be narrow:

OAF provides local, inspectable context and memory governance for agent
harnesses. It can show what context would be used, why it was selected or
excluded, how much it costs, which memory changes are only proposals, and what
external setup would change before any write happens.

Do not claim:

- arbitrary-code sandboxing;
- public internet connectors;
- automatic cloud memory;
- universal graph retrieval superiority;
- vector/graph database support;
- autonomous publishing;
- silent compatibility with every agent harness;
- Supermemory, Gortex, Graphify, Serena, MEX, SMFS, or LLM Bridge integration
  as an enabled default.

## Security Stop Conditions

Stop for maintainer review if an implementation:

- enables an external adapter or external write;
- mutates real home-directory harness configs;
- installs or downloads parsers, language servers, model providers, or MCP
  helpers;
- broadens filesystem or network access;
- persists raw prompts, raw context bodies, outputs, credentials, provider
  URLs, local paths, cookies, headers, hidden reasoning, or transcripts;
- lets retrieved content change policy, grants, tool availability, or permanent
  memory state;
- adds graph/vector databases, hosted model providers, embeddings, browser
  automation, or shell execution to the default path;
- copies upstream source or query files without a license/provenance review.

## Immediate Next Approved Slice

The safest first implementation after approval is Phase 1:

1. Add the deterministic benchmark dataset schema.
2. Add fixtures with gold evidence IDs and distractors.
3. Add phase-separated benchmark reports.
4. Run exact/lexical/harness-preview baselines.
5. Prove current OAF behavior before adding AST or graph sources.

That gives a hard measurement floor. Then AST and graph work can prove it is
better instead of adding complexity on faith.

