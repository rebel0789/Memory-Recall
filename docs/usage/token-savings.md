# Token Savings Measurement

Memory Recall measures delivered context reduction. It does not claim provider
billing savings unless a provider bill is measured separately.

## Fast Report

```bash
recall token-saver
```

This runs the practical context-pack path and reports how much smaller the
delivered handoff is than the local baseline.

## Reproducible Bench Commands

```bash
recall bench session --read-only --root . --format json
recall bench temporal --read-only --root . --format json
recall bench realqa --read-only --root . --format json
recall bench locomo --read-only --root . --dataset /path/to/locomo10.json --format json
recall bench locomo --read-only --root . --dataset /path/to/locomo10.json --limit 48 --budget 4096 --format summary
recall graph stats --root . --format summary
recall graph search --root . --query "auth workflow" --format summary
recall graph trace --root . --symbol runAuthWorkflow --format summary
node scripts/rust-eval.mjs
```

`bench locomo` is a model-free retrieval benchmark for the public LoCoMo JSON
shape. It ingests dialogue turns and generated observations into a temporary
proposal-gated SQLite memory store, retrieves context with question-only
queries, and reports evidence recall, non-adversarial answer-string coverage,
delivered tokens, token reduction versus full-conversation context, and local
latency. It does not claim official generative QA F1 because no model API is
called.

On the public `locomo10.json` file, the `--limit 48 --budget 4096` setting
measured 78% evidence-any recall, 67% evidence-all recall, 58% answer-string
coverage on non-adversarial questions, and 84.79% fewer delivered tokens than
full-conversation context. The report fingerprint from that run was
`sha256:cf75a6ee5bc3c34917800d8034f106fc03a01bf2bc03dd8c600d11ce279e0b28`.

`graph stats` is the fastest way to inspect source-graph compression without
raw source bodies. On this repository it delivered 4,136 graph-summary tokens,
avoided 3,135,082 full-graph JSON tokens, and reported a 99.87% local delivery
reduction while showing actionable hotspot and entry-point locators. Use the
number as source-graph transport evidence, not as a provider billing claim.

## What Counts

- Selected local context locators.
- Required-read lists.
- Handoff and MCP resource payload size.
- Cursor and delta behavior for repeated MCP calls.
- Correctness checks for stale or conflicting facts.

## What Does Not Count

- Provider billing tokens.
- Hidden model prompts inside another product.
- Hosted memory API storage or retrieval cost.
- Production latency.

Use the numbers as local evidence that Memory Recall sends less repeated repo
context while preserving enough proof for a coding agent to continue safely.
