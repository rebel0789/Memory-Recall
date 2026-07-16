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
Both modes are read-only. A missing or invalid binary fails clearly; there is no
silent fallback. Commands without `--engine` and all MCP graph tools continue
to use the JS engine.

## Verify from a source checkout

```bash
cargo test --manifest-path rust/Cargo.toml
node scripts/rust-eval.mjs
node scripts/rust-ingest-quality.mjs
node scripts/rust-realworld-bench.mjs
node scripts/rust-code-intelligence-protocol-quality.mjs
node scripts/native-code-intelligence-consumer-smoke.mjs
node scripts/code-intelligence-phase1-compatibility.mjs --check
```

Some Rust benchmark scripts clone public repositories before running local
commands. Treat those as optional evidence gates, not install-time behavior.
The Phase 1 compatibility runner fetches exact commits from the pinned corpus.
Its passing gate proves deterministic bounded execution, not the published
accuracy floor. The stored results show native import and call gaps, so the
preview remains non-default.
