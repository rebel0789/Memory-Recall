# Benchmark Proof

This page is the source of truth for Memory Recall's public measurements. The
artifact shape is stated for each benchmark below: most CLI benches emit JSON
with a `reportFingerprint`, while the Context Recall script emits JSON without
that field and the product-proof commands deliberately render summaries. The
Phase 0 baseline and Phase 1 JS/TS compatibility receipt are the committed
versioned code-intelligence results. Save other output yourself if you need to
retain a run.

All token figures are local delivery estimates using `ceil(chars/4)`. They are
not provider-billed tokens, production-cost estimates, or production-latency
claims. Run `recall` after a global install. From a source checkout, replace it
with `npm run recall --`.

## Public claims

| Claim | Metric | Scope |
| --- | --- | --- |
| Truth-floor regression gate | Fixture pass/fail for retrieval, exclusion, leakage, and deterministic output | Synthetic fixture; a merge gate, not a user-task benchmark |
| Context-recall gate | Gold-hit rate, file recall, returned estimated tokens, and savings ratio | Repository-specific tracked-file gold set; worktree-dependent |
| Session delta | Six-call current-truth fixture: 6/6 correct and 72% lower estimated delivery (816 vs 2,928) | Synthetic cursor-delta fixture |
| Temporal current truth | 10/10 correct and clean current answers against the included evolving-fact fixture | Synthetic temporal fixture; not a token-saving result |
| Structured-ingest sufficiency | 12/12 checkout-derived provider/default answers present after structured ingest | In-repo sufficiency check; not real-world QA |

## Code-intelligence Phase 0 baseline

The committed receipt is
`evals/code-intelligence/results/phase0-baseline.json`. Reproduce it from a
clean source checkout with:

```bash
node scripts/code-intelligence-phase0-baseline.mjs --out evals/code-intelligence/results/phase0-baseline.json
```

The receipt records the checkout commit, clean or dirty state, platform, Node
and Rust versions, input fingerprints, and six command receipts. Each command
receipt contains its exit code, duration, byte counts, and SHA-256 hashes of
standard output and standard error. It does not store command output,
environment variables, or an absolute repository root.

Phase 0 checks the bounded public JavaScript and TypeScript graph tests, the
Rust release build and test suite, and the existing Rust ingest, typed-call,
and incremental quality harnesses. The Rust engine remains experimental and is
not selected by the public npm CLI, MCP server, or web workbench.

The pinned 42-repository corpus and accuracy floors are inputs for later
language and head-to-head work. Phase 0 does not run a competitor, does not
establish fourteen-language accuracy, and makes no parity or leadership claim.
Competitor records are explicitly `unmeasured`.

## Code-intelligence Phase 1 compatibility

The committed receipt is
`evals/code-intelligence/results/phase1-js-ts-compatibility.json`. Check it from
a source checkout after building the release Rust binary:

```bash
node scripts/code-intelligence-phase1-compatibility.mjs --check
```

The runner fetches the exact pinned TypeScript and Express commits, uses a
bounded compiler-transformer scope for the large TypeScript repository, and
runs both engines twice on those repositories plus two local fixtures. Both
engines receive the same 1,000-file, 512 KiB-per-file, 5,000-node, and
10,000-edge request limits. The receipt stores commit references, platform and
engine versions, graph fingerprints, counts, and compatibility dimensions. It
does not store source bodies, command output, checkout paths, or environment
variables.

The Phase 1 gate covers boundary behavior and reproducibility. It passes four
completed deterministic cases with two pinned real repositories and no engine
network, model, memory, or workspace writes. It is not an accuracy gate. The
real-repository dimensions expose native import and call gaps, so the JS engine
remains the public default and no parity or leadership claim is made.

## Dataset

| Claim | Dataset |
| --- | --- |
| Truth-floor regression gate | `evals/benchmark-truth-floor/cases.v1.json`, a synthetic gold-evidence fixture. |
| Context-recall gate | `evals/context-recall/oaf-repo-gold.v1.json`, ten repository-specific gold cases evaluated against tracked files in the current checkout. |
| Session delta | `evals/temporal/gold.v1.json`, ten evolving-fact cases; the session path uses the `auth_token_ttl` case across six calls. |
| Temporal current truth | `evals/temporal/gold.v1.json`, ten evolving facts with superseded values. |
| Structured-ingest sufficiency | Answers derived from the current checkout's `PROJECT_STATUS.json` defaults and provider manifests, up to twelve cases. |

## Baseline

| Claim | Baseline |
| --- | --- |
| Truth-floor regression gate | Exact, full, lexical, and current-harness fixture baselines, plus leakage checks. |
| Context-recall gate | `lexical-pack`, or a caller-supplied safe `external-baseline-json`; no competitor baseline ships with the repository. |
| Session delta | Full resend of `memory.recall` plus `context.profile` on every call. |
| Temporal current truth | Keyword top-k over the same raw timeline text. It is deliberately judged on correctness and stale-value cleanliness. |
| Structured-ingest sufficiency | Legacy generic ingest of the same checkout-derived source material. |

## Command

| Claim | Reproduction command |
| --- | --- |
| Truth-floor regression gate | `recall benchmark truth-floor --suite benchmark-truth-floor --dataset evals/benchmark-truth-floor/cases.v1.json --format json` |
| Context-recall gate | `npm run eval:context-recall -- --budgets 8000` from a source checkout. |
| Session delta | `recall bench session --read-only --root . --format json` |
| Temporal current truth | `recall bench temporal --read-only --root . --format json` |
| Structured-ingest sufficiency | `npm run recall -- bench realqa --read-only --root . --format json` from a Memory Recall source checkout |

## Result artifact

| Claim | Generated artifact |
| --- | --- |
| Truth-floor regression gate | JSON on standard output with `reportFingerprint`. |
| Context-recall gate | JSON on standard output containing the dataset, mode, thresholds, gate decision, and results. It does not emit `reportFingerprint`. |
| Session delta | JSON on standard output with `reportFingerprint`. |
| Temporal current truth | JSON on standard output with `reportFingerprint`. |
| Structured-ingest sufficiency | JSON on standard output with `reportFingerprint`. |

Reports are intentionally not committed: context-recall and structured-ingest
runs depend on the checked-out repository, and fixtures can change with code.
Do not cite a protocol schema example as a completed benchmark run. Preserve the
command, checkout revision, JSON output, and `reportFingerprint` when the
command provides one.

The npm package bundles the truth-floor, session, temporal, sufficiency, and
LoCoMo fixtures. Installed benchmark commands resolve those exact fixture paths
from the package when they are absent from the target repository. The
structured-ingest command remains source-checkout-only because it derives its
questions from this repository's `PROJECT_STATUS.json` and provider manifests.

## Pass condition

| Claim | Pass condition |
| --- | --- |
| Truth-floor regression gate | `gateDecision` is `pass`; the fixture enforces full required-locator recall, at least 90% distractor exclusion, selected-token ratio at most 0.7, no leakage, and deterministic output. |
| Context-recall gate | No missing gold; hit rate at least 1.0; average file recall at least 0.7; average returned estimate at most 8,000; savings ratio at least 0.99. |
| Session delta | All six calls return the current value, including the persisted-cursor restart; `headline.correctnessGatePassed` is true. The included fixture currently reports 72% lower estimated delivery. |
| Temporal current truth | Every case is current, correct, and clean; `headline.oafWins` is true because it beats the keyword baseline on correctness and cleanliness. |
| Structured-ingest sufficiency | `headline.correctnessGatePassed` is true and every evaluated checkout-derived answer is present in both recall and profile output. |

## Limitations

- These are local fixtures or checkout-specific gates, not a leaderboard and
  not a comparison against another product.
- `bench temporal` currently delivers more estimated tokens than its keyword
  baseline. Its claim is correct, clean current truth, not token savings.
- `bench realqa` is named for CLI compatibility. It is an in-repo
  structured-ingest sufficiency check, not a real-world question-answering
  evaluation.
- Benchmark commands use isolated temporary SQLite stores where needed. They
  report zero workspace-file writes, zero network calls, zero model calls, and
  no provider-billing claim; temporary fixture state is not a production memory
  migration.
- The Context Recall gold set is specific to this repository. An external
  baseline must be supplied and passes safe tracked-path validation; it is not
  bundled evidence for a competitor comparison.

## Read-only product proof commands

These summary commands inspect actual product behavior but do not create a
public performance claim or a benchmark JSON artifact:

```bash
recall map --root . --sqlite .local/memory.sqlite --format summary
recall context handoff --read-only --from codex --root . --objective "Prepare handoff" --step "select next agent context" --target codex --format summary
recall memory refine --read-only --root . --sqlite .local/memory.sqlite --format summary
recall graph stats --root . --format summary
recall mcp inspect --read-only --root . --format summary
```

`map` and `graph stats` cover the implemented bounded JS/TS static graph.
`context handoff`, `memory refine`, and `mcp inspect` expose their own
safeguards and status fields. Treat graph and handoff token reports as live
local measurements, not fixed provider-billing or cross-repository claims.

## Methods without a headline number

`npm run source-graph:large-smoke` creates a temporary 1,100-file JS fixture,
exercises the 1,000-file default scan bound, builds and reloads the persistent
index, changes one represented file, and verifies that refresh parses one file
while reusing 999 shards. The JSON includes cold, warm, and one-file refresh
times plus graph and index sizes. Those values are machine-specific and are not
a production latency or million-node claim.

`recall bench locomo --read-only --root . --dataset evals/locomo/smoke.v1.json --budget 512 --limit 4 --format json`
is a model-free retrieval-coverage method. The committed smoke fixture contains
one conversation and three questions. Its report explicitly says it does not
measure official generative QA F1, so this page makes no LoCoMo headline claim
until a pinned public dataset, license, checksum, and sanitized result artifact
are available.

`node scripts/rust-eval.mjs` is experimental source-checkout evidence after a
local Rust build. It fetches a moving external repository revision, so it is
not a packaged-product benchmark and this page makes no Rust performance
headline. See [Rust acceleration](usage/rust-acceleration.md) for the local
build boundary.

For a practical local context-pack report, run `recall token-saver`; it defaults
to a summary. Use `recall token-saver --format json` when you need its generated
JSON and `reportFingerprint`. It remains a live delivery estimate; see [token
savings measurement](usage/token-savings.md) for what is and is not counted.
