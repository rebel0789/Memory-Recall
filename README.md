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
  Governed SQLite memory. Read-only MCP. Rust code intelligence. No hosted account. No model API key.
</p>

Memory Recall turns a repository into a governed context source. New agent
sessions get reviewed repo facts, changed-file impact, required local reads,
and proof of what was sent instead of a giant pasted transcript.

```bash
npm install -g memory-recall
recall setup
recall handoff
```

## Why Developers Use It

| Need | What Memory Recall gives you |
| --- | --- |
| New agent session | A compact handoff with required local reads, changed-file coverage, hashes, and MCP proof. |
| Repo memory | SQLite/FTS5 facts that start as proposals and become ACTIVE only after review. |
| Fast local code intelligence | Rust ingest and graph/search paths for local repo analysis, with no hosted service required. |
| Long context pressure | Repeat MCP pulls use cursors and deltas instead of resending the same profile. |
| Trust | Dry-run first, confirm-gated writes, local-only storage, and no automatic transcript import. |
| Codebase context | Source graph hints, locator-only context packs, and manifest-backed selection. |

## Five-Minute Path

```bash
# Install the CLI.
npm install -g memory-recall

# Bootstrap local files and run the handoff verification gate.
recall setup
recall verify

# Preview local agent setup. This writes nothing.
recall connect codex --dry-run --format json
recall mcp install --client claude-code --dry-run --format json

# Build governed memory proposals. Facts are not trusted until reviewed.
recall memory ingest --root . --sqlite .local/memory.sqlite --format json
recall memory review --root . --sqlite .local/memory.sqlite --format summary

# Produce the compact handoff for the next coding agent.
recall handoff
```

The default path is local and explicit: no hosted account, no model API key, no
silent memory capture, and no automatic permanent memory.

Manual MCP install flow: run the `mcp install --client claude-code --dry-run --format json`
preview, review it, then run the printed `--apply --confirm <fingerprint>`
command only when the fingerprint matches. The installed server does not import harness history, enable write tools, call cloud/model APIs, or claim provider billing-token savings.

## Documentation

| Start | Reference |
| --- | --- |
| [Quickstart](docs/usage/local-agent-handoff.md) | [MCP server reference](docs/usage/mcp-server-reference.md) |
| [Codex setup](docs/usage/codex-setup.md) | [Memory lifecycle](docs/usage/memory-lifecycle.md) |
| [Claude Code setup](docs/usage/claude-code-setup.md) | [Token savings measurement](docs/usage/token-savings.md) |
| [Cursor setup](docs/usage/cursor-setup.md) | [Rust acceleration](docs/usage/rust-acceleration.md) |
| [Docs hub](docs/usage/README.md) | [Security model](docs/usage/security-model.md) |
| [Troubleshooting](docs/usage/troubleshooting.md) | [Launch plan](docs/open-source/launch-plan.md) |

## Verified Numbers

These are local measurements from this repository. They are delivery-token
estimates and correctness checks, not provider billing claims.

| Test | Result | Command |
| --- | ---: | --- |
| Session delta delivery | 72% fewer delivered tokens, 100% correct | `recall bench session --read-only --root . --format json` |
| Rust graph-query evaluation | 84.6% fewer delivered tokens, 62.5% fewer tool calls | `node scripts/rust-eval.mjs` |
| Current fact recall with stale facts present | 100% correct, 100% clean | `recall bench temporal --read-only --root . --format json` |
| Real repo QA after governed ingest | 12/12 answered | `recall bench realqa --read-only --root . --format json` |
| LoCoMo retrieval coverage | 78% evidence-any recall, 84.79% fewer delivered tokens | `recall bench locomo --read-only --root . --dataset /path/to/locomo10.json --limit 48 --budget 4096 --format json` |
| Practical context-pack report | 84.35% smaller than practical baseline | `npm run token-saver` |

Memory Recall is strongest when context changes over time, handoffs repeat, and
the next agent needs reviewed local truth. It is not a hosted memory API,
semantic embedding service, graph database, or billing-meter replacement.
The LoCoMo number is model-free retrieval coverage, not official generative QA
F1; the command does not call a model API.

## How It Compares

| Category | Usually strong at | Memory Recall position |
| --- | --- | --- |
| Hosted memory APIs | Cross-app memory, cloud connectors, managed retrieval | Better when a hosted memory backend is desired. Memory Recall is better for local-first repo handoff with no API key. |
| Persistent agent memory frameworks | Long-term personalization and retrieval across products | Stronger as general memory layers. Memory Recall is narrower: repo-scoped, proposal-gated, and inspectable. |
| Temporal graph memory | Changing facts, provenance, entity relationships | Memory Recall has local temporal facts and supersession, but does not claim a full temporal graph database. |
| Code graph MCP tools | Static code graph search and token-heavy repo compression | Memory Recall combines code locators with governed memory, handoff manifests, MCP proof, and local UX. |
| IDE indexing | Smooth editor-native search | Memory Recall is more explicit: it shows what was selected, excluded, pinned, and delivered. |

## What Works Now

- Dependency-free Node.js 22 bootstrap with no paid service, database server, or
  model API required.
- Native SQLite/FTS5 governed memory with temporal facts, supersession, entity
  edges, proposal queue, explicit approve/reject, and no hard delete.
- Read-only `recall mcp server` exposing `memory.recall`, `context.profile`, and
  `context.pack` over local stdio with active facts separated from proposals.
- Persisted MCP cursors and `since` deltas so repeated reads send only changed
  current truth, including after restart.
- Preview-then-confirm install paths for Claude Code, Cursor, and Codex with
  explicit project root and project SQLite memory path.
- Local `/memory` cockpit over the loopback Control API with temporal facts,
  proposal counts, MCP delivery stats, and confirm-gated approvals.
- Rust workspace for local ingest, governed graph/search, wiki, MCP, and the
  graph-query evaluation path. Rust source ships in the npm package; build
  output stays out of the tarball.
- Deterministic local benches for temporal correctness, session delta delivery,
  and real repo question answering.

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
recall verify
recall connect codex --dry-run --format json
recall mcp install --client claude-code --dry-run --format json
recall memory ingest --root . --sqlite .local/memory.sqlite --format json
recall memory review --root . --sqlite .local/memory.sqlite --format summary
recall memory refine --read-only --root . --sqlite .local/memory.sqlite --format json
recall token-saver
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

Development kit: **1.0.3**.

| Surface | Status |
| --- | --- |
| Source checkout | Local-ready reference path |
| npm package | Published as `memory-recall` |
| CLI | `recall` primary, `oaf` compatibility alias |
| Marketplace / plugin registry | Manifest prepared; not submitted |
| Client hooks | Opt-in Codex/Claude connect writer; dry-run/manual fallback |

Run `npm run status` for the checked-in task state. Run
`npm run task -- <OAF-ID>` only when status names a next task.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Keep changes evidence-backed, local by
default, and honest about what is implemented versus planned.
