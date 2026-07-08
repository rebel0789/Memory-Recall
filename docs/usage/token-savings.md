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
node scripts/rust-eval.mjs
```

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

