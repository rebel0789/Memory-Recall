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

## Verify

```bash
cargo test --manifest-path rust/Cargo.toml
node scripts/rust-eval.mjs
node scripts/rust-ingest-quality.mjs
node scripts/rust-realworld-bench.mjs
```

Some Rust benchmark scripts clone public repositories before running local
commands. Treat those as optional evidence gates, not install-time behavior.
