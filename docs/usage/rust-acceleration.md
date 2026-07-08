# Rust Acceleration

Memory Recall is not "all Rust." The public npm install path is a zero-account
Node.js CLI. The repository also ships a Rust workspace for fast local repo
intelligence.

Use this wording publicly:

> Memory Recall uses a Rust core for fast repo intelligence and graph-style code
> queries, wrapped in a zero-account Node.js CLI for easy install.

## What Rust Does

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

```bash
cargo build --release --manifest-path rust/Cargo.toml
```

The release binary is:

```bash
rust/target/release/oaf
```

Build output is intentionally excluded from the npm tarball. The Rust source is
included so users can inspect and build it locally.

## Verify

```bash
cargo test --manifest-path rust/Cargo.toml
node scripts/rust-eval.mjs
node scripts/rust-ingest-quality.mjs
node scripts/rust-realworld-bench.mjs
```

Some Rust benchmark scripts clone public repositories before running local
commands. Treat those as optional evidence gates, not install-time behavior.

