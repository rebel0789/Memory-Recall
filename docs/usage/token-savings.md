# Token Savings Measurement

Memory Recall measures local delivered context. It does not claim provider
billing savings unless you measure a provider bill separately. Every public
number, dataset, baseline, command, artifact, pass condition, and limitation is
listed in [Benchmark proof](../benchmarks.md).

## Fast report

```bash
recall token-saver
# Use this form when you need a JSON artifact and report fingerprint.
recall token-saver --format json
```

This is a live local context-pack measurement. The default output is a summary;
`--format json` produces the generated report and fingerprint. Neither form is
a fixed product-wide percentage or provider-billing statement.

## Reproduce the bounded claims

```bash
recall bench session --read-only --root . --format json
recall bench temporal --read-only --root . --format json
recall benchmark truth-floor --suite benchmark-truth-floor --dataset evals/benchmark-truth-floor/cases.v1.json --format json
recall graph stats --root . --format summary
recall graph search --root . --query "auth workflow" --format summary
recall graph trace --root . --symbol runAuthWorkflow --format summary
```

The session fixture measures cursor deltas against full resend. The temporal
fixture measures current, clean truth against a keyword timeline baseline; it
is not a savings claim. These commands resolve their bundled datasets from the
installed package when the target repository does not contain them.

The `realqa` command is a source-checkout-only structured-ingest sufficiency
check over Memory Recall's own status and provider manifests. It is not
real-world question answering:

```bash
npm run recall -- bench realqa --read-only --root . --format json
```

## LoCoMo method, not a headline

```bash
recall bench locomo --read-only --root . --dataset evals/locomo/smoke.v1.json --budget 512 --limit 4 --format json
```

This is a model-free retrieval-coverage method. The committed smoke fixture has
one conversation and three questions. It reports evidence coverage and local
delivery estimates, explicitly does not score official generative QA F1, and
does not call a model API. Memory Recall does not publish a LoCoMo performance
headline until a pinned public dataset, license, checksum, and sanitized result
artifact are available.

## Experimental Rust evaluation

`node scripts/rust-eval.mjs` is a source-checkout-only experiment after a local
Rust build:

```bash
cargo build --release --manifest-path rust/Cargo.toml
node scripts/rust-eval.mjs
```

It reads `rust/target/release/oaf` and fetches an external public repository.
That moving input makes it unsuitable as a packaged-product benchmark or a
stable headline. It does not run during `npm install`, `recall setup`, `recall
handoff`, or `recall token-saver`.

## What counts

- Selected local context locators and required-read lists.
- Handoff and MCP payload delivery estimates.
- Cursor and delta behavior for repeated MCP reads.
- Fixture correctness and stale-value cleanliness checks.

## What does not count

- Provider billing tokens or hidden prompts inside another product.
- Hosted-memory storage or retrieval costs.
- Production latency or a cross-product benchmark result.

Use these reports to inspect whether a specific local workflow sends less
repeated context while retaining enough evidence for the next coding agent.
