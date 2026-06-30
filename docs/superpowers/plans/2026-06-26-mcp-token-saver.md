# Strategy + Goal: OAF as a local MCP context/memory server for coding agents

## Market read (2026)

- **The #1 pain in coding-agent land is token cost from re-sent context.** Agentic
  coding consumes ~1,000× the tokens of chat; the average Claude Code / Cursor /
  Codex developer spends **$400–$1,500+/month**, and **re-sent context is ~62% of
  the bill** — the single biggest optimization target.
- **Agent memory is a crowded, fast-moving market** (Mem0: 48k★/$24M; Zep on the
  Graphiti temporal graph; Letta/MemGPT; Supermemory). But most require cloud
  and/or a graph/vector DB, and the consensus is that **framework lock-in kills
  adoption** — framework-agnostic wins.
- **MCP is the universal integration layer**: ~97M monthly SDK downloads, native in
  Claude Code / Cursor / Claude Desktop; 200+ servers. Memory-for-coding-agents via
  MCP is already a recognized niche (ContextForge, Memory MCP, Supermemory MCP).

## The decision

**Position OAF as the local-first, governed memory + context MCP server that cuts
a coding agent's token bill — works with Claude Code, Cursor, and Codex, no cloud,
no API key.**

Why this fits both the market and the tool:

- **Hits the #1 pain directly.** OAF already proves an ~87% delivery-token
  reduction via the compressed governed profile + context pack. Re-sent context is
  62% of the bill; this attacks it.
- **Differentiated where competitors are weak.** Local-first + zero-infra (SQLite,
  no API key, no graph/vector DB), **governed** (proposal gate, bi-temporal
  supersession, provenance, replay), and **measured** (provable savings). Mem0/Zep
  are cloud + DB; the "notes" MCP servers are ungoverned and unmeasured.
- **Framework-agnostic by construction.** MCP means it feeds Claude Code / Cursor /
  Codex rather than replacing them — exactly what the market rewards.
- **The user is the first customer.** They use Codex/Claude Code daily; this makes
  OAF save *their* tokens every day. Product-market fit starts at home.
- **It is the natural culmination of the repo.** OAF-031 was the "context intake
  harness bridge"; the context pack, harness-setup planner, read-only MCP
  resources, memory, and token measurement already exist. This connects them into
  one sellable outcome.

Honest edge (not hype): OAF is **not** first to "memory MCP for coding agents."
Its honest advantage is **local-first + governed + measured**, not novelty. Claims
stay measured (delivery tokens, not billing), and config writes stay
preview-then-confirm.

## Goal: "MCP Token-Saver" (build on codex/surface-wire)

Make OAF a real MCP server the user can add to their coding agent, serving
compressed governed context + memory, with a provable before/after token saving.

### M1 — Production MCP stdio server

Expose, over MCP stdio (what Claude Code/Cursor/Codex speak), read-only:
- `memory.recall` — governed bi-temporal facts for a query + scope (active,
  non-superseded, with provenance).
- `context.profile` — the compressed, token-budgeted context (the 87%-saving
  profile) for an objective.
- `context.pack` — the existing safe handoff.

Build on the existing read-only MCP scaffolding. No raw source bodies, no secrets,
no write tools. Tests assert protocol-shaped responses + redaction.

### M2 — One-command connect (preview → confirm, never silent)

`oaf mcp install --client claude-code|cursor|codex` that:
- `--dry-run` (default): prints the exact ready-to-paste MCP server config for that
  client.
- `--apply`: writes it only behind an explicit confirmation, redacted and
  reversible (extend the existing harness-setup planner; keep its safety stance —
  no silent home-config writes).

### M3 — Provable token saving (real before/after)

`oaf measure savings` (extend the measurement): compare delivery tokens via OAF's
compressed profile vs the naive full-context baseline for a realistic scenario;
output a before/after token count + %; surface it in the `/memory` cockpit and the
demo. Honest: delivery-token estimate, not provider billing.

### M4 — Positioning (optional, last)

README quickstart: "Add OAF to Claude Code in one command; cut re-sent-context
tokens, locally." Honest limitations.

### Global rules

Local-first only (no external service, network, model API, new runtime dep).
Read-only MCP by default; config writes are preview-then-confirm. Reuse the
existing MCP, harness-setup, context-compiler, memory, and measurement code — do
not reimplement. Few high-value tests; never weaken a test. Checkpoint protocol
(commit per green `npm run ci`, stop at first blocker).
