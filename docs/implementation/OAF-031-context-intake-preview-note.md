# OAF-031 Context Intake Preview Note

Status: implemented on the OAF-031 context-intake branch as a preview-only
slice.

## Behavior

- `npm run oaf -- context scan --from <codex|claude|cursor|all> --root . --dry-run`
  scans documented project-visible harness files and returns sanitized
  `HarnessContextSource` records.
- `npm run oaf -- context preview --from all --root . --objective "..." --step "..." --dry-run`
  converts accepted scan records into temporary Context Compiler candidates,
  runs deterministic selection, and returns a sanitized preview report.
- `npm run oaf -- context pack --from all --root . --objective "..." --step "..." --target codex --include-file docs/context.md --dry-run --format markdown`
  builds a schema-validated Markdown handoff for Codex, Claude Code, Cursor, or
  a generic agent from selected safe locators. `--include-file` may be repeated
  for explicit user-selected relative workspace files; these become
  proposal-only `user-selected://` locators. `--write --out
  context-packs/CONTEXT_PACK.md` is the only local write path and writes the
  generated handoff report, not canonical memory.
- Preview output contains safe locators, hashes, reason codes, token counts,
  selected/excluded decisions, a proposal-only memory plan, safeguards, and a
  preview fingerprint.
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
  search, call tracing, and changed-file impact reports.
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
- `npm run oaf -- memory sgrep "..." --records memory-export.json --workspace ws_local --dry-run --format json`
  returns local source-grounded memory search results with lifecycle state,
  evidence IDs, and optional context-manifest reason codes.
- The native SQLite memory provider now preserves memory-core lifecycle and
  review fields and includes a local proposal queue with idempotent
  fingerprints, leases, retries, and poison/error records.

## Safety Boundary

- No source snapshots are persisted.
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
- Raw source bodies, prompts, outputs, credentials, provider URLs, local paths,
  and hidden reasoning are not present in public scan or preview reports.
- Source-index outputs are hashes, safe workspace locators, symbol names, and
  relationship metadata only; they are not authoritative source snapshots and
  they do not execute code or acquire parser/language-server dependencies.
- The AST provider's exact-slice reader is a root-bounded internal verification
  helper. It is not exposed through provider query results, protocol fixtures,
  benchmark reports, or persisted context manifests.

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
- Read-only MCP exposure of sanitized OAF resources.
- Optional disabled adapters for external memory or code-intelligence systems
  after pin, checksum, license, trust-boundary, and conformance review.
