# Open Agent Fabric Rust Runtime

This workspace builds the local-first OAF Rust runtime:

- `oaf-store`: governed SQLite memory, graph, search, wiki, and MCP data surfaces.
- `oaf-ingest`: source ingestion into proposal-gated File/Module/Function/Class/Method facts and graph edges.
- `oaf`: the CLI, MCP server, local UI, install receipt, and benchmark entrypoint.

Runtime behavior stays local-first. The Rust binary does not require model calls,
cloud services, external databases, or network access for ingest, memory, search,
graph, wiki, UI, or MCP operation. Benchmark scripts may clone public repositories
before running local OAF commands.

## Build

```bash
cargo build --release --manifest-path rust/Cargo.toml
```

The release binary is:

```bash
rust/target/release/oaf
```

On macOS this is a single-file OAF binary with normal system dylib/framework
links. Signing, notarization, package-manager publishing, and checksums are
deferred release tasks.

## Quickstart

From the repository root:

```bash
RUST_BIN=rust/target/release/oaf
SQLITE=.local/oaf-rust.sqlite

$RUST_BIN ingest --root . --sqlite "$SQLITE" --workers 4 --format json
$RUST_BIN memory approve --all --root . --sqlite "$SQLITE" --format json
$RUST_BIN search --query "changed file impacts" --mode hybrid --semantic --root . --sqlite "$SQLITE" --format json
$RUST_BIN graph explain --entity function:impact_detect_changes_command --root . --sqlite "$SQLITE" --format json
$RUST_BIN ui --root . --sqlite "$SQLITE" --port 8765 --format json
```

Then open the reported loopback URL. The UI and `/wiki` assets are compiled in
and do not use a CDN.

## Verification

Run the normal repo gate:

```bash
npm run ci
```

Run the Rust release harnesses:

```bash
cargo build --release --manifest-path rust/Cargo.toml
cargo test --manifest-path rust/Cargo.toml
node scripts/rust-ingest-quality.mjs
node scripts/rust-incremental-quality.mjs
node scripts/rust-typed-calls-quality.mjs
node scripts/rust-realworld-bench.mjs
node scripts/rust-fresh-clone-smoke.mjs
```

`scripts/rust-realworld-bench.mjs` clones five public repositories, then measures
local OAF ingest, recall quality, token/tool-call reduction, semantic hybrid vs
keyword, an agent-session graph use case, conversational consolidation, and the
local wiki.

`scripts/rust-fresh-clone-smoke.mjs` performs a local fresh clone, builds the
Rust binary inside that clone, ingests the clone, approves proposals, and runs a
hybrid search.
