# Codex goal — OAF Rust supertool, Milestone M2: MCP server parity + single binary

Date: 2026-06-29. Owner: rebel. Runtime: long autonomous run (overnight ok).
Authoritative design: `docs/product/oaf-rust-supertool-spec.md` — READ IT FIRST.
Predecessor: M1 (branch `codex/rust-core-m1`, governance core, verified). The verified
Node OAF is the conformance oracle. This goal builds M2 ONLY.

## 0. Mission
Make the Rust binary a drop-in MCP stdio server that exposes OAF's read-only brain tools
(memory.recall, context.profile, context.pack) with full JSON-RPC lifecycle, byte-identical
to the Node `oaf mcp server` for the same requests, shipped as a single static binary. Do
NOT build tree-sitter, Cypher, semantic search, loop runtime, UI, install, or any
write-via-MCP — those are later milestones. Stop cleanly at the definition of done or the
first blocker you cannot resolve without guessing Node's behavior.

## STEP 0 (MANDATORY, do this first) — put the Rust stack on the CORRECT oracle
The M1 branch was based on a pre-fix Node (its oracle still had the entity-dedup/tokenizer
bugs). Before building M2:
1. Rebase `codex/rust-core-m1` onto `codex/graph-ui` (commit 11fd02e — the consolidated Node
   tip containing ALL brain fixes: sanitizer, delta, loop-governance, graph-queries,
   graph-scale-fix, UI; 435 Node tests). The `/rust` commits + the two new Node files
   (rust.yml, scripts/rust-recall-conformance.mjs) are isolated — the rebase must be
   conflict-free. If a conflict appears, STOP and report; do not force-resolve.
2. Re-run `node scripts/rust-recall-conformance.mjs` against the now-fixed Node. Confirm
   scenarios A and B still byte-parity AND that the `nodeInternalEntityDedup` known-gap is
   GONE (the fixed Node now dedupes entities by name, matching Rust). If the gap persists,
   STOP and report — do not proceed to M2.
3. New worktree `codex/rust-core-m2` off the rebased branch. Then build M2.

## 1. Repository & build isolation (unchanged from M1 — do not break the build)
All new code under `/rust`. Do NOT modify any Node file except the existing conformance
script and the existing `rust.yml`. Node `npm run ci` (435 tests on the graph-ui base) must
stay green at the end. `/rust` keeps its own Cargo workspace + CI job. No network/model at
runtime.

## 2. Scope — IN vs OUT
IN: JSON-RPC 2.0 stdio lifecycle; tools/list (schemas matching Node); tools/call for
memory.recall (extend M1), context.profile, context.pack; resources/list; prompts/list;
ping; the per-(tool,args) cursor auto-delta store; single static binary entry
`oaf mcp server --read-only --stdio`.
OUT (scope violation if built): tree-sitter ingestion, graph path/explain/Cypher, semantic
search, loop.verify/run, architecture.overview, the graph UI, install/distribution flow,
any write tool exposed over MCP (writes stay CLI-only, matching Node's read-only server).

## 3. MCP protocol (match Node exactly — Node is the oracle)
- JSON-RPC 2.0 over stdio. protocolVersion and serverInfo must match Node's
  `oaf mcp server` initialize response.
- Methods: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`,
  `resources/list`, `prompts/list`. Error objects (code/message) match Node for unknown
  method / bad params / unknown tool.
- `tools/list` returns the same tool names, descriptions, and inputSchema as Node
  (memory.recall, context.profile, context.pack). Byte-compare the tools/list payload.

## 4. Tools (byte-conformant with Node's MCP outputs)
- `memory.recall`: reuse M1; full current-truth + cursor delta `{c,d,r}` + retraction +
  the per-(tool,args) cursor store (auto-applies persisted cursor when `since` absent,
  persists `next` after each call) — match Node's `--cursors` behavior and default path
  `.local/mcp-cursors.json`.
- `context.profile`: compute the compressed profile / contextBudget exactly as Node's MCP
  `context.profile` does for the same arguments. Read Node's implementation; match its JSON.
- `context.pack`: implement to byte-match Node's MCP `context.pack` output. If — and only
  if — full parity is not achievable within this goal, you MAY defer context.pack with a
  clear written reason and a failing-but-skipped marker; everything else must pass. Do not
  silently approximate.
- All read-only: no tool mutates the store. `_meta.oaf` side-effect class = read-only,
  matching Node.

## 5. Single binary
`cargo build --release` produces ONE binary that serves both the M1 CLI subcommands and
`oaf mcp server --read-only --root . --sqlite <db> [--cursors <f>] --stdio`. No external
runtime deps.

## 6. Conformance harness (extend the existing one) — THE GATE
Add MCP-level cases: drive the SAME JSON-RPC request sequence (initialize → tools/list →
tools/call for each tool, incl. a delta sequence that exercises the cursor) through BOTH
the Node `apps/cli/oaf.mjs mcp server` and the Rust binary against the SAME SQLite, on the
real scenarios (notes-api supersession DB + OAF self-ingest DB). Assert byte-identical
result JSON (ignore only generatedAt/fingerprint). NEVER weaken an assertion to pass — fix
the Rust side. If context.pack is deferred per §4, mark it explicitly, not silently.

## 7. Benchmark
MCP init+recall, tools/call latency, peak RSS for the Rust binary vs the Node baseline
(init+recall 60ms/60MB). Report a table. Real numbers only.

## 8. Invariants
Local-first; read-only MCP; no network; no model; cursor store the only writable state and
it stays inside the workspace.

## 9. Checkpoint protocol & stop conditions
Commit after each green `cargo build && cargo test && node scripts/<harness>`. Stop at the
first blocker you can't resolve without guessing Node's behavior; report what's ambiguous.
No `unsafe` without justification + test. Touch no Node files beyond the existing harness.

## 10. Definition of done (all must hold)
- [ ] Step 0 done: rebased onto graph-ui, M1 conformance re-passes, entity-dedup gap gone.
- [ ] `/rust` builds release; `cargo test` green.
- [ ] MCP lifecycle + tools/list + memory.recall + context.profile byte-parity vs Node
      (context.pack parity OR an explicit, reasoned deferral).
- [ ] Single binary serves CLI + `mcp server --stdio`.
- [ ] Benchmark table reported.
- [ ] Node `npm run ci` still green (435), Node untouched except the one harness + CI job.
- [ ] Honest report: per-method/tool parity, bench, and any unmatched behavior surfaced.

## 11. Reporting
End with: step-0 result (rebase + gap-gone confirmation), per-tool byte-parity table, the
benchmark table, the DoD checklist state, and an explicit "could not match / deferred /
open questions" list. Real numbers only; if partial, say so plainly.
