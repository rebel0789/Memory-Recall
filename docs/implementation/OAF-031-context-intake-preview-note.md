# OAF-031 Context Intake Preview Note

Status: implemented on the OAF-031 context-intake branch as a preview-only
slice.

## Behavior

- `npm run oaf -- context scan --from <codex|claude|cursor|all> --root . --dry-run`
  scans documented project-visible harness files and returns sanitized
  `HarnessContextSource` records.
- `npm run oaf -- context preview --from <codex|claude|cursor|all> --root . --objective "..." --step "..." --dry-run`
  converts accepted scan records into temporary Context Compiler candidates,
  runs deterministic selection, and returns a sanitized preview report.
- `npm run oaf -- context pack --from codex --root . --objective "..." --step "..." --target codex --include-file docs/context.md --changed apps/web/app.js --changed-from-git --dry-run --format markdown`
  builds a schema-validated Markdown handoff for Codex, Claude Code, Cursor, or
  a generic agent from selected safe locators. The browser defaults to the Codex
  source family and requires explicit checkbox selection before scanning
  Claude Code or Cursor project files. `--include-file` may be repeated for
  explicit user-selected relative workspace files; these become
  proposal-only `user-selected://` locators. `--changed` may be repeated for
  explicit user-named changed files; these become `workspace://` impact hints
  from the native source graph, not raw source slices. `--changed-from-git` is
  an explicit read-only helper that reads local `git status` metadata, skips
  secret-looking and forbidden paths, caps output at 16 reviewed locators, and
  never reads diffs or file bodies. The browser exposes the same helper as a
  button that fills the changed-file textarea for review before building.
  `--write --out context-packs/CONTEXT_PACK.md` writes the generated markdown
  handoff report, not canonical memory. `--use-out
  context-packs/CONTEXT_PACK.use.json` additionally writes a schema-validated
  use-plan artifact for local harnesses. Both paths are explicit, repo-relative,
  bounded to `context-packs/`, and keep the original pack object in dry-run
  semantics; the CLI write report records the local files written.
- Preview output contains safe locators, hashes, reason codes, token counts,
  selected/excluded decisions, a proposal-only memory plan, safeguards, and a
  preview fingerprint.
- Context packs now include reversible omission refs for excluded records:
  stable `omit_` IDs, locators, content hashes, token costs, reason codes, and
  recovery hints. They also report source-graph omitted match counts without
  embedding source slices.
- Context packs include a schema-backed utility read plan and launch prompt.
  The read plan records required local reads, source-graph representation for
  changed locators, graph-hint coverage, redacted content hashes for safely
  readable changed files, and source-selection reduction so first-use readiness
  does not rely only on safety gates or delivery-token reduction. Missing,
  oversized, binary, escaping, or non-graph changed-file locators keep the read
  plan in review with explicit reason codes instead of pretending the local file
  was source-graph verified.
- Context packs also preserve explicit requested inputs separately from
  selected context. A user-selected file that is excluded by the selector under
  token budget remains visible as a `requestedInputs` locator, a required
  utility read, and a generated `--include-file` command argument, without
  embedding its raw body.
- Context pack handoff fields reject obvious secret-like values and absolute
  local filesystem paths before rendering markdown or shell commands, because
  objective and step text are intentionally visible in the handoff artifact.
- The deterministic benchmark gate in `evals/harness-context/cases.json`
  measures required-locator recall, distractor exclusion, selected-token ratio,
  leakage, deterministic fingerprints, and disabled side-effect surfaces.
- `npm run oaf -- benchmark truth-floor --suite benchmark-truth-floor --dataset evals/benchmark-truth-floor/cases.v1.json --format json`
  exposes the schema-validated gold-evidence truth floor for native exact,
  full-context, lexical, and current-harness baselines.
- `providers/native/context-candidate-ast-code/` exposes a dependency-free
  JS/TS static source index with definitions, references, imports, exports,
  callers, callees, file outlines, repository outlines, exact slice hashes, and
  content-hash journals.
- The same native provider now exposes a read-only derived source graph built
  from that JS/TS source index, with schema-validated file/chunk/symbol/module
  nodes, contains/defined/import/export/reference/call edges, lexical graph
  search, call tracing, and changed-file impact reports. The parser uses a
  linear string/comment stripper and bounded reference/call fanout so large
  template-heavy project files cannot spin the CLI, API, or browser preview.
- Durable context manifests now record explicit assembly representation tiers,
  token budget reports, manifest `etag`s, and `deltaFrom` summaries for
  repeated local runs. The token report separates selected-token ratio
  (selected original tokens over total candidate tokens) from assembled-token
  ratio (assembled tokens over selected original tokens).
- `npm run oaf -- memory profile --records memory-export.json --root . --dry-run --format json`
  renders a generated `memory/profile.md` report from accepted active OAF
  memory only. `--write` is explicit and writes only the generated local report.
- `npm run oaf -- memory proposals --records memory-export.json --root . --dry-run --format json`
  renders generated `memory/proposals/*.md` reports for pending and quarantined
  memory records. `--from memoryPaths --config oaf.memory.json` reads explicit
  workspace-relative files as proposal sources only.
- Memory proposal reports include source diagnostics inspired by markdown-memory
  failure modes: source role, source hash, line count, byte size, age, stale
  source warnings, and memory-index line/byte cliff warnings. These are review
  signals only and do not activate memory.
- `npm run oaf -- memory sgrep "..." --records memory-export.json --workspace ws_local --dry-run --format json`
  returns local source-grounded memory search results with lifecycle state,
  evidence IDs, and optional context-manifest reason codes.
- `npm run oaf -- mcp resources --read-only --format json` lists sanitized
  OAF-owned MCP resources for local harnesses: status, latest context manifest,
  latest run, memory proposals, and handoff/artifact summary.
- `npm run oaf -- mcp resources --read-only --uri oaf://workspace/ws_local/context/latest --format json`
  reads one resource as a schema-validated JSON envelope. `--stdio` accepts
  local JSON-RPC messages on stdin and writes JSON-RPC responses to stdout.
- `npm run oaf -- mcp resources --read-only --context-pack --from codex --objective "..." --step "..." --target codex --changed apps/cli/oaf.mjs --uri oaf://workspace/ws_local/context-pack/current --format json`
  exposes an opt-in current context-pack summary resource for harnesses. The
  resource carries safe locators, hashes, omission counts, source-selection
  token counts, delivery-budget metrics for the locator handoff, and changed-file
  impact; it does not include raw objective text, raw step text, markdown
  bodies, source bodies, private local paths, active memory, model calls,
  network calls, external adapters, or write tools.
- `npm run oaf -- context pack --from codex --objective "..." --step "..." --target codex --write --out context-packs/CONTEXT_PACK.md --use-out context-packs/CONTEXT_PACK.use.json --format json`
  exports the markdown handoff plus a sanitized `context-pack-use-plan` JSON
  file. The use plan carries the complete required-read list, content hashes,
  changed-locator coverage, source-selection metrics, handoff artifact hash,
  and pack fingerprint. It omits objective text, step text, launch prompt,
  markdown content, source content, credentials, provider URLs, absolute paths,
  model calls, network calls, external adapters, active memory, and write tools.
- `npm run oaf -- mcp resources --read-only --context-pack-use context-packs/CONTEXT_PACK.use.json --uri oaf://workspace/ws_local/context-pack/use-plan/current --format json`
  reads that exported use plan through the read-only MCP resource catalog. The
  path is restricted to `context-packs/*.use.json`; absolute paths, traversal,
  backslashes, symlink parents, and non-file targets fail closed.
- `npm run oaf -- mcp smoke context-pack --read-only --from codex --objective "..." --step "..." --target codex --changed apps/cli/oaf.mjs --format json`
  launches the same read-only stdio MCP resource bridge, reads
  `oaf://workspace/ws_local/context-pack/current`, asserts `tools/list` returns
  no tools, and returns an observed local measurement report with duration,
  response size, resource size, selected/candidate source units, and
  delivered-handoff units. These measurements describe one local invocation only
  and are not production latency or external benchmark claims.
- The browser context-pack result now surfaces the same proof boundary in plain
  UI terms: estimated local handoff reduction, estimated source kept, observed
  local request time, raw-body exclusion, model-call count, and external-write
  state. These are local pack-building signals, not provider billing-token or
  hosted latency claims.
- The Control API also reads each freshly built pack through the in-process
  read-only MCP bridge before returning it to the browser. The returned readback
  proof records the resource fingerprint, context-pack fingerprint match,
  resource byte size, zero exposed tools, no markdown body, and the
  `single local in-process bridge read` measurement scope. The CLI smoke above
  remains the separate stdio-path proof.
- The native SQLite memory provider now preserves memory-core lifecycle and
  review fields and includes a local proposal queue with idempotent
  fingerprints, leases, retries, and poison/error records.
- The browser shell includes a read-only Fabric Map at `/fabric-map` that
  visualizes source intake, normalization, context compilation, workflow,
  model, tool, evidence, memory, approval, and disabled-adapter boundaries from
  current sanitized dashboard state.

## Safety Boundary

- No source snapshots are persisted.
- Git changed-file detection is opt-in only. It reads local status metadata,
  not diffs, raw source bodies, remotes, hooks, submodules, credentials, or
  caller-supplied filesystem roots.
- No active memory is created.
- No model calls are made.
- No network calls are made.
- No external writes or external adapters are enabled.
- Generated memory files are reports only; ordinary file edits do not create or
  activate canonical memory.
- `memoryPaths` config is explicit, workspace-relative, size-bounded, and used
  only to create proposal reports.
- Context packs contain locators, hashes, reason codes, warnings, and
  instructions only. They do not embed raw source bodies or grant authority.
- `requestedInputs` records explicit source-family choices, user-selected
  locators, and changed locators as safe locators and counts only.
- Omission refs are not hidden context. They let a later user or agent recover
  skipped context by explicitly reading the local locator.
- Raw source bodies, prompts, outputs, credentials, provider URLs, local paths,
  and hidden reasoning are not present in public scan or preview reports.
- Source-index outputs are hashes, safe workspace locators, symbol names, and
  relationship metadata only; they are not authoritative source snapshots and
  they do not execute code or acquire parser/language-server dependencies.
- The AST provider's exact-slice reader is a root-bounded internal verification
  helper. It is not exposed through provider query results, protocol fixtures,
  benchmark reports, or persisted context manifests.
- The Fabric Map is an observer surface only. It does not add telemetry, import
  harness chat history, call models, activate memory, enable external adapters,
  enable external writes, or render raw context bodies.
- Read-only MCP resources are local summaries only. They do not start a network
  listener, expose write tools, mutate canonical state, create memory, write
  source snapshots, call models, perform external egress, or include raw
  prompts, source bodies, model results, credentials, provider URLs, absolute
  local paths, or hidden reasoning.

## Prior Art Boundary

Gortex was verified from source at commit `5062fdc8a040`: its
`bench/token-efficiency` runner and `bench/fixtures/retrieval.yaml` are real
benchmark infrastructure. OAF copies the benchmark posture, not the code graph
engine, daemon, embeddings, mutating MCP tools, or performance claims.

## Still Planned

- Broader native graph work after the source, compiler, token, and memory
  baselines are established, including graph candidate-source records,
  repository-scale benchmarks, and bounded subgraph selection into context
  manifests.
- Automatic harness chat history import and active-memory activation.
- Optional disabled adapters for external memory or code-intelligence systems
  after pin, checksum, license, trust-boundary, and conformance review.
