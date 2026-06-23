# Context Preview Token Benchmark Plan

Goal: add a preview-only Slice 2 for the OAF context-intake harness bridge that
proves harness context can be normalized, compiler-selected, and benchmarked
without activating memory, adapters, models, network, or writes.

## Scope

- Add `context preview --dry-run` for Codex, Claude Code, and Cursor scanner
  output.
- Convert safe scan records into temporary Context Compiler candidates.
- Return a sanitized preview manifest with ids, locators, hashes, reason codes,
  token counts, and fingerprints only.
- Add a deterministic benchmark suite for required-locator recall, distractor
  exclusion, leakage, persistence safety, and token-efficiency ratio.
- Add protocol schema and fixtures for the preview report.
- Document the Gortex prior-art verification and the boundary: OAF copies the
  benchmark discipline, not Gortex code, graph storage, embeddings, daemon, or
  mutating MCP surface.

## Non-goals

- No source snapshot persistence.
- No memory import or active memory creation.
- No graph/vector database, embeddings, hosted providers, public network, or
  external adapters.
- No claim that OAF outperforms Gortex at code graph retrieval.
- No backlog or `PROJECT_STATUS.json` mutation for this scoped branch slice.

## Verification

- Add failing tests first:
  - `tests/harness-context-preview.test.mjs`
  - `tests/harness-context-benchmark.test.mjs`
  - CLI preview assertions in `tests/cli.test.mjs`
  - protocol preview fixture coverage.
- Implement smallest code path needed to pass.
- Run focused tests, `npm run protocol:validate`, `npm run eval`, and
  `npm run ci`.

## Acceptance Gates

- Preview output contains no raw source body, raw secret, local path, prompt,
  output, provider URL, credential, or hidden reasoning.
- Preview reports `persisted:false`, `modelCalls:0`, `networkCalls:0`,
  `sourceSnapshotsWritten:0`, `activeMemoryCreated:0`, `externalWrites:false`,
  and `externalAdaptersEnabled:0`.
- Benchmark aggregate metrics pass:
  - required locator recall is `1`;
  - distractor exclusion rate is at least `0.9`;
  - selected token ratio is at most `0.65`;
  - leakage counts are `0`;
  - deterministic fingerprints match across reruns.
