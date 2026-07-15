# Memory Recall

<p align="center">
  <img src="assets/brand/readme-card.svg" alt="Memory Recall: local repo memory and context for coding agents" width="900">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/memory-recall"><img alt="npm" src="https://img.shields.io/npm/v/memory-recall?style=flat-square&label=npm&color=56E0C4"></a>
  <a href="https://github.com/rebel0789/Memory-Recall/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/rebel0789/Memory-Recall/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/rebel0789/Memory-Recall/actions/workflows/rust.yml"><img alt="Rust" src="https://github.com/rebel0789/Memory-Recall/actions/workflows/rust.yml/badge.svg?branch=main"></a>
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-111827?style=flat-square"></a>
  <a href="package.json"><img alt="Node.js 22+" src="https://img.shields.io/badge/node-%3E%3D22-111827?style=flat-square"></a>
  <a href="docs/architecture/protocol-bridges.md"><img alt="MCP read-only" src="https://img.shields.io/badge/MCP-read--only-56E0C4?style=flat-square"></a>
</p>

<p align="center">
  <strong>Local repo memory and context for Codex, Claude Code, Cursor, and other coding agents.</strong><br>
  Governed SQLite memory. Read-only MCP. Experimental Rust acceleration requires a local build. The default local path needs no hosted account or model API key.
</p>

Memory Recall turns a repository into a governed context source. New agent
sessions get reviewed repo facts, changed-file impact, required local reads,
and proof of what was sent instead of a giant pasted transcript.

The current source checkout is the 1.1.0 release candidate. npm still serves
1.0.5, which does not include Recall Map. Until 1.1.0 is published, run the
current quickstart from a source checkout:

```bash
git clone https://github.com/rebel0789/Memory-Recall.git
cd Memory-Recall
npm install
npm run recall -- setup
npm run recall -- map --root . --sqlite .local/memory.sqlite --format summary
npm run recall -- handoff
```

`recall setup` creates only local state. `recall map` is the explicit first
read-only repository scan; it does not run silently during setup. After 1.1.0
is published, the global `recall` commands are the equivalent installed path.

Normal quickstarts use `recall`. The [developer-first product contract](docs/product/memory-recall-developer-first.md)
defines the `implemented`, `experimental`, and `unsupported` capability
vocabulary. See [Compatibility identifiers](docs/usage/oaf-compatibility.md)
for preserved legacy names and URIs.

## Why Developers Use It

| Need | What Memory Recall gives you |
| --- | --- |
| New agent session | A compact handoff with required local reads, changed-file coverage, hashes, and MCP proof. |
| Repo memory | SQLite/FTS5 facts that start as proposals and become ACTIVE only after review. |
| Fast local code intelligence | Implemented JS/TS static graph; experimental Rust ingest and graph/search require a local build. |
| First look at a repository | Recall Map shows bounded source coverage, entry points, changed impact, and separate memory status without writing. |
| Long context pressure | Repeat MCP pulls use cursors and deltas instead of resending the same profile. |
| Trust | Dry-run first, confirm-gated writes, local-only storage, and no automatic transcript import. |
| Codebase context | Source graph hints, locator-only context packs, and manifest-backed selection. |

## Five-Minute Path

```bash
# Install the current source release candidate.
git clone https://github.com/rebel0789/Memory-Recall.git
cd Memory-Recall
npm install

# Create local state only. This does not scan the repository.
npm run recall -- setup

# Run the first explicit read-only repository map.
npm run recall -- map --root . --sqlite .local/memory.sqlite --format summary

# Run the handoff verification gate.
npm run recall -- verify

# Preview local agent setup. This writes nothing.
npm run recall -- connect codex --dry-run --format json
npm run recall -- mcp install --client claude-code --dry-run --format json

# Build governed memory proposals. Facts are not trusted until reviewed.
npm run recall -- memory ingest --root . --sqlite .local/memory.sqlite --format json
npm run recall -- memory review --root . --sqlite .local/memory.sqlite --format summary

# Produce the compact handoff for the next coding agent.
npm run recall -- handoff
```

The default path is local and explicit: no hosted account, no model API key, no
silent memory capture, and no automatic permanent memory.

Optional semantic setup uses the active coding agent or one explicitly
consented provider request to create pending proposals from selected
documentation. Start with the body-free plan:

```bash
npm run recall -- semantic plan --harness codex --root . --dry-run
npm run recall -- semantic task --harness codex --root .
npm run recall -- semantic import --input semantic-result.json --root . --sqlite .local/memory.sqlite
```

The CLI does not invoke the harness. Direct API execution requires a user-owned
environment credential and `--allow-network`. See
[Semantic setup](docs/usage/semantic-setup.md) for data limits and explicit-ID
approval.

Manual MCP install flow: run the `mcp install --client claude-code --dry-run --format json`
preview, review it, then run the printed `--apply --confirm <fingerprint>`
command only when the fingerprint matches. That path installs the five-tool
read-only MCP server. `recall connect` is separate: it installs a resource
bridge plus hooks for Codex or Claude Code, and its MCP `tools/list` is empty.
The support matrix names the difference and reversal path.

## Documentation

| Start | Reference |
| --- | --- |
| [Quickstart](docs/usage/local-agent-handoff.md) | [MCP server reference](docs/usage/mcp-server-reference.md) |
| [Recall Map](docs/usage/recall-map.md) | [Security model](docs/usage/security-model.md) |
| [Semantic setup](docs/usage/semantic-setup.md) | [Memory lifecycle](docs/usage/memory-lifecycle.md) |
| [Codex setup](docs/usage/codex-setup.md) | [Memory lifecycle](docs/usage/memory-lifecycle.md) |
| [Claude Code setup](docs/usage/claude-code-setup.md) | [Token savings measurement](docs/usage/token-savings.md) |
| [Cursor setup](docs/usage/cursor-setup.md) | [Rust acceleration](docs/usage/rust-acceleration.md) |
| [Docs hub](docs/usage/README.md) | [Security model](docs/usage/security-model.md) |
| [Troubleshooting](docs/usage/troubleshooting.md) | [Launch plan](docs/open-source/launch-plan.md) |
| [Support matrix](docs/usage/support-matrix.md) | [Benchmark proof](docs/benchmarks.md) |
| [Uninstall and data preservation](docs/usage/uninstall.md) | [Token savings measurement](docs/usage/token-savings.md) |
| [Developer-first contract](docs/product/memory-recall-developer-first.md) | [Compatibility identifiers](docs/usage/oaf-compatibility.md) |

## Reproducible Proof

Every public measurement names its dataset, baseline, command, generated JSON
artifact, pass condition, and limitation in [Benchmark proof](docs/benchmarks.md).
They are local delivery-token estimates and correctness checks, not provider
billing claims.

| Fixture or gate | Current claim | Command |
| --- | ---: | --- |
| Session cursor-delta fixture | 6/6 current answers and 72% lower estimated delivery than full resend | `recall bench session --read-only --root . --format json` |
| Temporal current-truth fixture | 10/10 correct and clean; not a token-saving claim | `recall bench temporal --read-only --root . --format json` |
| In-repo structured-ingest sufficiency | 12/12 checkout-derived answers present after structured ingest | `recall bench realqa --read-only --root . --format json` |
| Truth-floor regression gate | Fixture-backed merge gate, not a user-task benchmark | `recall benchmark truth-floor --suite benchmark-truth-floor --dataset evals/benchmark-truth-floor/cases.v1.json --format json` |

Memory Recall is designed for changing repository context, repeated handoffs,
and reviewed local truth. It is not a hosted memory API,
semantic embedding service, graph database, billing-meter replacement, or
cross-product benchmark leaderboard.

## How It Compares

| Category | Usually strong at | Memory Recall position |
| --- | --- | --- |
| Hosted memory APIs | Cross-app memory, cloud connectors, managed retrieval | Use a hosted service when managed cross-app memory is required. Memory Recall focuses on local repository handoff. |
| Persistent agent memory frameworks | Long-term personalization and retrieval across products | Choose these for cross-product personalization. Memory Recall stores repo-scoped proposals and exposes their sources and approval state. |
| Temporal graph memory | Changing facts, provenance, entity relationships | Memory Recall has local temporal facts and supersession, but does not claim a full temporal graph database. |
| Code graph MCP tools | Static code graph search and token-heavy repo compression | Memory Recall combines code locators with governed memory, handoff manifests, MCP proof, and local UX. |
| IDE indexing | Smooth editor-native search | Memory Recall reports which context units were selected, excluded, pinned, and delivered; it does not replace editor-native search. |

## Current Capabilities

- Dependency-free Node.js 22 bootstrap with no paid service, database server, or
  model API required.
- Native SQLite/FTS5 governed memory with temporal facts, supersession, entity
  edges, proposal queue, explicit approve/reject, and no hard delete.
- Bounded semantic setup packets for Codex, Claude Code, Cursor, or a generic
  harness; strict result import; pending-only proposals; and source-rechecked
  named approval. Optional direct API execution is experimental and explicitly
  consented.
- Read-only `recall mcp server` exposing `memory.recall`, `context.profile`,
  `context.pack`, `repo.map`, and `code.impact` over local stdio with active
  facts separated from proposals.
- Persisted MCP cursors and `since` deltas so repeated reads send only changed
  current truth, including after restart.
- Preview-then-confirm install paths for Claude Code, Cursor, and Codex with
  explicit project root and project SQLite memory path.
- Local `/memory` cockpit over the loopback Control API with temporal facts,
  proposal counts, MCP delivery stats, and confirm-gated approvals.
- Experimental Rust acceleration paths for local ingest, governed graph/search,
  wiki, MCP, and static analysis when explicitly invoked. They require a local
  `cargo build --release` before use; Rust source ships in the npm package, but
  build output stays out of the tarball.
- Deterministic local benches for temporal correctness, session delta delivery,
  and checkout-derived structured-ingest sufficiency.

## Safety Model

Memory Recall is built around explicit authority:

- memory ingest creates proposals, not trusted facts;
- active memory requires review and approval;
- rejections and supersessions are recorded, not silently deleted;
- MCP resources are read-only by default;
- setup and connect commands support dry-run previews;
- local storage remains local unless you intentionally move it;
- external adapters stay disabled until reviewed, pinned, licensed, and tested.

See [Security model](docs/usage/security-model.md), [fork policy](docs/open-source/fork-policy.md),
and [integration policy](docs/adr/0012-build-the-whole-tool-own-the-boundaries.md)
for the deeper boundary rules.

## What Is Not Claimed

Production PostgreSQL repositories, production authentication, hosted embeddings,
vector databases, hosted memory sync, write-capable MCP tools, automatic harness
history import, real social connectors, hardened sandboxes, signed Agent Pack
distribution, and a production frontend framework are not claimed.

`PROJECT_STATUS.json` is the machine-readable source for current capability
status and limitations.

## Useful Commands

```bash
recall setup
recall map --root . --sqlite .local/memory.sqlite --format summary
recall verify
recall connect codex --dry-run --format json
recall mcp install --client claude-code --dry-run --format json
recall memory ingest --root . --sqlite .local/memory.sqlite --format json
recall memory review --root . --sqlite .local/memory.sqlite --format summary
recall memory refine --read-only --root . --sqlite .local/memory.sqlite --format json
recall token-saver
recall graph stats --root . --format summary
recall graph search --root . --query "auth workflow" --format summary
recall graph trace --root . --symbol runAuthWorkflow --format summary
recall context handoff --read-only --from codex --root . --objective "Prepare handoff" --step "select next agent context" --target codex --format summary
recall handoff
```

For source checkouts, use `npm run recall -- <command>` instead of the global
`recall` binary.

```bash
npm run recall -- memory refine --read-only --root . --sqlite .local/memory.sqlite --target-active-facts 200 --format json
npm run recall -- context handoff --read-only --from codex --root . --objective "Prepare handoff" --step "select next agent context" --target codex --changed apps/web/app.js --format json
```

## Repository Map

| Path | Purpose |
| --- | --- |
| `apps/` | Local web and CLI interfaces |
| `services/` | Application services and Control API |
| `packages/` | Provider-neutral domain packages, schemas, Agent Packs, and replay logic |
| `providers/native/` | Local baseline provider implementations |
| `rust/` | Local ingest, graph/search, wiki, and MCP workspace |
| `docs/usage/` | User-facing install, setup, memory, MCP, security, and measurement docs |
| `evals/` | Deterministic regression datasets |
| `tests/` | Node test suite and release checks |

See [REPOSITORY_MAP.md](REPOSITORY_MAP.md) for ownership and dependency
boundaries.

## Status

Source release candidate: **1.1.0**. Published npm version: **1.0.5**.

| Surface | Status |
| --- | --- |
| Source checkout | 1.1.0 local-ready release candidate |
| npm package | 1.0.5 published; Recall Map quickstart awaits the 1.1.0 release |
| CLI | `recall` |
| Marketplace / plugin registry | Manifest prepared; not submitted |
| Client hooks | Opt-in Codex/Claude connect writer; dry-run/manual fallback |

Run `npm run status` for the checked-in task state. Run
`npm run task -- <OAF-ID>` only when status names a next task.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Keep changes evidence-backed, local by
default, and honest about what is implemented versus planned.
