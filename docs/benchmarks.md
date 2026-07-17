# Benchmark Proof

This page is the source of truth for Memory Recall's public measurements. The
artifact shape is stated for each benchmark below: most CLI benches emit JSON
with a `reportFingerprint`, while the Context Recall script emits JSON without
that field and the product-proof commands deliberately render summaries. The
Phase 0 baseline, Phase 1 JS/TS compatibility receipt, Phase 2 Tier 1 audit, and
Phase 3 source-index receipt are the committed versioned code-intelligence
results. Save other output yourself if you need to retain a run.

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

## Code-intelligence Phase 2 Tier 1 audit

The committed aggregate is
`evals/code-intelligence/results/phase2-tier1-summary.json`. Reproduce it after
building the local release Rust binary:

```bash
node scripts/code-intelligence-phase2-tier1.mjs --check
```

The aggregate binds five batch receipts covering 14 fixtures and all 42 pinned
repositories at their exact commits and bounded scopes. Each graph is built
twice with a 5,000-file, 512 KiB-per-file, 5,000-node, and 10,000-edge limit.
The stored audit records 52,388 nodes, 117,989 edges, 82,862,298 serialized
graph bytes, 15,665.420 ms summed first-run wall time, 15,750.958 ms summed
second-run wall time, and 208,800 KiB peak evaluator RSS on the recorded macOS
arm64 run. These machine-specific resource values are evidence receipts, not
performance promises.

All 56 cases are deterministic and pass their reviewed truth: 0 duplicate
canonical symbols, 0 repository parse failures, 0 network calls, 0 model calls,
0 canonical-memory writes, and 0 workspace writes. Six repository scopes hit a
node or edge budget and store only safe reason/count diagnostics. The audit
does not hide those omissions.

Across 154 Tier 1 capability cells, 49 meet the Phase 2 evidence floor, none has
a recorded floor failure, and 105 remain unmeasured or not applicable. A row
requires reviewed evidence from its fixture and all three repositories before
it can say `meets-floor`. JavaScript is the first language to meet every
applicable sampled row; the other thirteen remain overall `unmeasured`. The
native engine stays an unbundled preview; the npm, MCP, and
web defaults remain JS. Competitors remain unmeasured, and the receipt makes no
parity, leadership, multi-repository, or scale claim.

## Code-intelligence Phase 3 source index

The committed receipt is
`evals/code-intelligence/results/phase3-source-index.json`. Verify its pinned
inputs, fingerprint, safety boundary, and pass decision with:

```bash
node scripts/code-intelligence-phase3-index.mjs --check
```

Run the script without `--check` to fetch the same exact commits into temporary
directories and remeasure them. The stored clean run used Memory Recall commit
`919d10e1f6e7b7038f9510e5057fc0b3b82155cf` on macOS 25.5 arm64, Apple M2 Max,
Node 22.22.3. It covers a 600-file TypeScript dependency fixture, the pinned
HashiCorp go-multierror repository, the pinned Express repository, and the
pinned TypeScript compiler-transformers scope.

Across 781 files, 6,808 nodes, and 15,115 edges, the four cold builds had a
machine-specific p50 of 156.646 ms and maximum of 910.639 ms. Warm status p50
was 13.362 ms; no-change refresh p50 was 23.411 ms. The 600-file fixture parsed
zero files on an exact no-op refresh, 11 files after the sampled isolated file
change, and 5 files after the sampled dependency-impact change. All no-op and
reader checks preserved the exact SQLite bytes and modification time.

The receipt stores five-sample exact, neighborhood, impact, and trace timings,
response bytes, database sizes, changed/reused counts, evaluator RSS, omissions,
and safe diagnostics per case. These are machine-specific preview measurements,
not latency promises. The engine made no network or model calls; the benchmark
harness made three network fetches to obtain the pinned repositories. It does
not measure a packaged native binary, competitors, multi-repository behavior, or
million-node scale, so it makes no parity or leadership claim.

## Code-intelligence Phase 4 intelligence

The committed receipt is
`evals/code-intelligence/results/phase4-intelligence.json`. Verify its
fingerprint, pass decision, evidence integrity, and claim boundary with:

```bash
node scripts/code-intelligence-phase4-intelligence.mjs --check
```

The local fixture builds four disconnected TypeScript areas plus one Next.js
route-to-handler call chain. Five repeated reads prove deterministic exact,
lexical, and one-hop structural search alongside bounded communities and an
evidence-backed process. The same fixture proves that an outbound depth-two
calls-only query retains both call steps and their source-backed endpoints while
excluding other edge kinds. Every query stays below the bounded two-second deadline
and preserves the exact SQLite bytes and modification time. The committed
receipt records the machine-specific p95 values.

This is a deterministic local correctness and deadline gate, not a competitor
benchmark or a general latency promise. It makes no parity, leadership,
multi-repository, packaged-binary, or million-node claim.

## Code-intelligence Phase 5 cross-service gate

Verify `evals/code-intelligence/results/phase5-cross-service.json` with:

```bash
node scripts/code-intelligence-phase5-cross-service.mjs --check
```

Five TypeScript fixture reads prove a gateway-to-orders import, call, trace,
and process. Negative cases and bounds pass, reads preserve SQLite, and the
recorded macOS arm64 p95 was 8.027 ms. This is single-repository evidence; no
registry, multi-repository, parity, leadership, or scale claim is made.

## Native package consumer gate

Run the checkout-only installed-product gate after a release build:

```bash
cargo build --release -p oaf --manifest-path rust/Cargo.toml --locked
node scripts/native-code-intelligence-consumer-smoke.mjs
```

On the reviewed macOS arm64 run, the platform tarball contained exactly one
verified native binary and installed beside the root tarball without registry
access or install scripts. With Cargo and rustc unavailable at runtime, the
installed provider returned parser-produced graph evidence for all fourteen
Tier 1 languages and completed SQLite build, status, and query operations. The
gate also checks checksum/version selection, source and governed-memory
preservation, and unchanged installed package bytes. It is a current-platform
consumer gate, not cross-platform, signing, publication, parity, or leadership
evidence.

The same gate removes both packages, verifies that the executable and package
roots are gone while the workspace SQLite bundle and governed memory are
unchanged, then installs the exact same tarballs into a fresh prefix and reopens
the existing generation for representative TypeScript, Python, and Go queries.
That proves same-version reinstall survivability, not cross-version downgrade.

The five-target Rust CI matrix reuses this installed-consumer gate with the
exact unsigned tarball produced by each native runner. Only the macOS arm64 lane
has been reproduced locally; the workflow configuration does not count as a
passing result for the other four targets.

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
