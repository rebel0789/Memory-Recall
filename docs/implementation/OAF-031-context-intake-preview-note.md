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
- Preview output contains safe locators, hashes, reason codes, token counts,
  selected/excluded decisions, a proposal-only memory plan, safeguards, and a
  preview fingerprint.
- The deterministic benchmark gate in `evals/harness-context/cases.json`
  measures required-locator recall, distractor exclusion, selected-token ratio,
  leakage, deterministic fingerprints, and disabled side-effect surfaces.

## Safety Boundary

- No source snapshots are persisted.
- No active memory is created.
- No model calls are made.
- No network calls are made.
- No external writes or external adapters are enabled.
- Raw source bodies, prompts, outputs, credentials, provider URLs, local paths,
  and hidden reasoning are not present in public scan or preview reports.

## Prior Art Boundary

Gortex was verified from source at commit `5062fdc8a040`: its
`bench/token-efficiency` runner and `bench/fixtures/retrieval.yaml` are real
benchmark infrastructure. OAF copies the benchmark posture, not the code graph
engine, daemon, embeddings, mutating MCP tools, or performance claims.

## Still Planned

- Proposal-only import into OAF-native memory proposals.
- Handoff export for Codex, Claude Code, Cursor, and similar harnesses.
- Read-only MCP exposure of sanitized OAF resources.
- Optional disabled adapters for external memory or code-intelligence systems
  after pin, checksum, license, trust-boundary, and conformance review.
