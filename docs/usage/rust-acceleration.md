# Rust Code Intelligence

Memory Recall keeps Node.js as the zero-account CLI and transport layer. Graph
reads default to the verified packaged Rust engine and its local SQLite index.
Missing, stale, corrupt, or incompatible native state returns a specific build,
refresh, repair, or package action. It never silently selects the JS engine.

Use this wording publicly:

> Memory Recall uses verified packaged Rust for production code intelligence,
> never builds the index from a read path, and keeps JS/TS analysis behind the
> explicit `compatibility` option during the migration window.

## What Rust Does

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

## Optional local build

The root npm tarball excludes Rust source and build output. Matching optional
platform packages carry verified binaries. No compiler runs as part of
`npm install`, `recall setup`, or `recall handoff`.

```bash
cargo build --release --manifest-path rust/Cargo.toml
```

The release binary is:

```bash
rust/target/release/oaf
```

Build output remains excluded from the root npm tarball. A source checkout can
still build the engine explicitly for development.

## Run the graph preview

Point Memory Recall at a local release binary when testing a source checkout:

```bash
MEMORY_RECALL_NATIVE_BINARY="$PWD/rust/target/release/oaf" \
  npm run recall -- graph stats --root . --engine native --format summary
```

Use `--engine compatibility` to receive the native graph plus bounded
file/symbol/import/call/route comparisons against the existing JS/TS graph.
Both modes are read-only. A missing or invalid native binary fails clearly.
Commands without `--engine` select native. `native-preview` and `auto` remain
strict native compatibility aliases; neither alias enables JS fallback.

## Build and query the native index

Writer operations stay explicit:

```bash
MEMORY_RECALL_NATIVE_BINARY="$PWD/rust/target/release/oaf" \
  npm run recall -- graph index --write --engine native --root . --format summary

MEMORY_RECALL_NATIVE_BINARY="$PWD/rust/target/release/oaf" \
  npm run recall -- graph index --query main --kind exact --engine native --root . --format json

MEMORY_RECALL_NATIVE_BINARY="$PWD/rust/target/release/oaf" \
  npm run recall -- graph index --doctor --engine native --root . --format summary
```

If doctor returns a repair plan, review it and pass its fingerprint to
`--repair --confirm <fingerprint>`. Native MCP reads only a
prebuilt index:

```bash
MEMORY_RECALL_NATIVE_BINARY="$PWD/rust/target/release/oaf" \
  npm run recall -- mcp server --read-only --engine native --root . --stdio
```

Native MCP never builds, refreshes, repairs, or writes governed memory. Normal
MCP startup uses the same strict native selection.

The former `auto` spelling remains a strict native alias:

```bash
MEMORY_RECALL_NATIVE_BINARY="$PWD/rust/target/release/oaf" \
  npm run recall -- mcp server --read-only --engine auto --root . --stdio
```

Native reads require a healthy, ready, current committed index. Every other
status returns an actionable error. Reads do not build, refresh, or repair the
index. Use `--engine compatibility` only when deliberately testing the temporary
bounded JS/TS implementation.

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
accuracy floor. The stored results still contain unmeasured language rows, so
auto selection is not a parity or leadership claim.
