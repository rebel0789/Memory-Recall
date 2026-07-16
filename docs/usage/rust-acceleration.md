# Experimental Rust Acceleration

Memory Recall's default public path is a zero-account Node.js CLI with an
implemented JS/TS static graph. Experimental Rust acceleration is opt-in and
requires a local build; it is not default shipping code intelligence.

Use this wording publicly:

> Memory Recall provides an implemented JS/TS static graph. Experimental Rust
> acceleration is opt-in and requires a local build; the npm package includes
> Rust source, not a built binary.

## What Rust Does After A Local Build

- local ingest over repository source;
- governed File, Module, Function, Class, Method facts;
- graph and search surfaces;
- wiki and local UI surfaces in the Rust runtime;
- MCP and benchmark entrypoints for Rust quality gates.
- a versioned JSON Lines code-intelligence engine used by explicit Node graph
  previews.
- an isolated SQLite source index with generation commits, incremental refresh,
  bounded queries, diagnosis, and confirm-gated repair.

## What Node.js Does

- npm distribution;
- bootstrap, setup, and verification commands;
- local web shell and control API;
- memory governance workflows;
- release readiness, protocol validation, and consumer smoke tests.

## Build

The npm tarball includes Rust source but no built Rust binary. No Rust command
runs as part of `npm install`, `recall setup`, or `recall handoff`.

```bash
cargo build --release --manifest-path rust/Cargo.toml
```

The release binary is:

```bash
rust/target/release/oaf
```

Build output is intentionally excluded from the npm tarball. The Rust source is
included so users can inspect and build it locally when they choose the
experimental acceleration path.

## Run the graph preview

Point Memory Recall at the local release binary and select the preview on each
read command:

```bash
MEMORY_RECALL_NATIVE_BINARY="$PWD/rust/target/release/oaf" \
  npm run recall -- graph stats --root . --engine native-preview --format summary
```

Use `--engine compatibility` to receive the native graph plus bounded
file/symbol/import/call/route comparisons against the existing JS/TS graph.
Both graph-read modes are read-only. A missing or invalid binary fails clearly;
there is no silent fallback. Commands without `--engine` continue to use the JS
engine.

## Build and query the native preview index

Writer operations stay explicit:

```bash
MEMORY_RECALL_NATIVE_BINARY="$PWD/rust/target/release/oaf" \
  npm run recall -- graph index --write --engine native-preview --root . --format summary

MEMORY_RECALL_NATIVE_BINARY="$PWD/rust/target/release/oaf" \
  npm run recall -- graph index --query main --kind exact --engine native-preview --root . --format json

MEMORY_RECALL_NATIVE_BINARY="$PWD/rust/target/release/oaf" \
  npm run recall -- graph index --doctor --engine native-preview --root . --format summary
```

If doctor returns a repair plan, review it and pass its fingerprint to
`--repair --confirm <fingerprint>`. Native MCP is also opt-in and reads only a
prebuilt index:

```bash
MEMORY_RECALL_NATIVE_BINARY="$PWD/rust/target/release/oaf" \
  npm run recall -- mcp server --read-only --engine native-preview --root . --stdio
```

The native MCP preview never builds, refreshes, repairs, or writes governed
memory. Normal MCP startup remains on the JS engine.

To opt into freshness-gated per-read selection while keeping a bounded fallback:

```bash
MEMORY_RECALL_NATIVE_BINARY="$PWD/rust/target/release/oaf" \
  npm run recall -- mcp server --read-only --engine auto --root . --stdio
```

Auto mode uses the native index only when status is healthy, ready, current,
and committed. Every other status is labeled and served by the bounded JS scan.
It does not build, refresh, or repair the index.

## Verify from a source checkout

```bash
cargo test --manifest-path rust/Cargo.toml
node scripts/rust-eval.mjs
node scripts/rust-ingest-quality.mjs
node scripts/rust-realworld-bench.mjs
node scripts/rust-code-intelligence-protocol-quality.mjs
node scripts/native-code-intelligence-consumer-smoke.mjs
node scripts/code-intelligence-phase1-compatibility.mjs --check
node scripts/code-intelligence-phase3-index.mjs --check
```

Some Rust benchmark scripts clone public repositories before running local
commands. Treat those as optional evidence gates, not install-time behavior.
The Phase 1 compatibility runner fetches exact commits from the pinned corpus.
Its passing gate proves deterministic bounded execution, not the published
accuracy floor. The stored results show native import and call gaps, so the
preview remains non-default.
