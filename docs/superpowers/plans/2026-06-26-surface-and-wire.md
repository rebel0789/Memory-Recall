# Surface & Wire — make the native core visible and connected

The native core (bi-temporal SQLite memory, FTS5/BM25 retrieval, proposal-gated
extraction, a measured >50% token-saving profile, the loop workbench) is **built
and CI-green** — but it is invisible: no UI renders it, the pieces are not
connected into one flow, and the token-saving number is hidden in CLI JSON.

This phase adds the **cockpit**: it surfaces the real data, wires one end-to-end
flow, and ships a one-command demo. **No new backend engines.** Build only on the
real data already in the repo — never mock data.

Base branch: `codex/native-core` (contains everything: G0–G7).

## Hard design rules (all sub-goals)

- **Real data only.** Read from the real `TemporalMemoryStore`
  (`providers/native/memory-sqlite`), the G5 compressed-profile `contextBudget`
  (`packages/context-compiler`), and the loop workbench. No placeholder/mock data
  in any view.
- **Use the existing UI shell.** Extend `apps/web` (dependency-free) and add
  control-API read endpoints, mirroring the existing `/loop-workbench` and
  `/context-pack` route pattern. No framework, no new build tooling, no runtime
  dependency.
- **Local-first only.** No external service required, no network, no model API.
  (S4's embedder is loopback-optional and degrades gracefully.)
- **Reuse, don't duplicate.** Use `packages/protocol/src/fingerprint.mjs`, the
  event ledger, schema validator, existing web components/routes.
- **Tests prove the surface is real.** Web-shell tests must assert the routes
  render the REAL fact fields and the REAL token-saving number — so a broken or
  mock UI fails CI. Few, high-value tests. Never weaken a test.
- **Checkpoint protocol** (see `docs/product/loop-workbench-build-plan.md` §2):
  commit per green `npm run ci`, stop at the first blocker, write
  `LOOP_WORKBENCH_BLOCKERS.md`, report.

## Sub-goals (in order)

### S1 — Memory & token cockpit (the visible win)

Make the existing `/memory` route render the real bi-temporal store:

- temporal facts: text, scope, **status** (observed→proposed→verified→active→
  superseded/retracted/expired), **validity window** (validFrom/validUntil),
  **supersession chain**, and **provenance** (episode);
- the proposal queue (proposal-gated extraction output);
- a prominent **token-savings hero**: the G5 `contextBudget`
  (`reductionRatio`, `historyTokensAvoided`, `estimatedDeliveryTokens`) shown as a
  headline number, not buried.

Add control-API read endpoints over `memory-sqlite` + the profile builder. Web-
shell tests assert the route renders real fact fields + the token number.

### S2 — Wire one end-to-end flow

Connect the islands into one visible story:

```text
objective -> compressed profile (show token budget) -> loop plan -> observe
          -> extraction proposal -> memory fact (validity + supersession)
```

Surface this connected flow in the `/loop-workbench` route (show the live token
budget and the resulting memory proposals). Add a CLI entry
`oaf demo memory-loop --root .` that runs the whole flow read-only/local.

### S3 — One-command demo + honest status

- `npm run demo:memory-loop`: seed a few facts (including a contradicting one to
  show supersession), run the connected flow, and print: the **token saving (%)**,
  what was remembered, and what was superseded.
- Update `PROJECT_STATUS.json` honestly for the **local profile** (do not claim
  team/cloud). Add a README quickstart line.

### S4 — Activate semantic retrieval (optional, LAST — skip if it blocks)

Make hybrid retrieval actually semantic: optional local embedder (loopback Ollama)
+ `sqlite-vec`, fused with FTS5/BM25 + temporal. **Must degrade gracefully** to
keyword + temporal when no embedder/extension is present, and require no external
service. If this cannot be done without a new hard dependency or network, leave
the interface in place, document it as inactive, and STOP — do not force it.

## Master prompt (paste into Codex)

```text
You are working in Open Agent Fabric. This is the "Surface & Wire" phase: make the
already-built native core VISIBLE and CONNECTED. Do NOT add new backend engines.

Read first and follow exactly:
- docs/superpowers/plans/2026-06-26-surface-and-wire.md (this plan)
- docs/product/loop-workbench-build-plan.md (§2 + Checkpoint Protocol)

Base on branch codex/native-core. Create a worktree codex/surface-wire.

Build S1 -> S2 -> S3 in order, each as its own commit; do S4 only if it needs no
external service or new dependency, else stop after S3.

S1: render the real bi-temporal memory in the /memory web route (facts with
status, validity window, supersession chain, provenance; the proposal queue) plus
a PROMINENT token-savings hero from the G5 contextBudget. Add control-API read
endpoints over providers/native/memory-sqlite and the context-compiler profile.
S2: wire objective -> compressed profile (show token budget) -> loop plan ->
observe -> extraction proposal -> memory fact, surfaced in /loop-workbench, plus
an `oaf demo memory-loop` CLI entry.
S3: `npm run demo:memory-loop` that seeds facts (incl. a contradicting one),
runs the flow, and prints the token-saving %, remembered, and superseded; update
PROJECT_STATUS honestly for the local profile; add a README quickstart line.
S4 (optional, last): activate semantic retrieval (loopback Ollama + sqlite-vec)
fused with FTS5/temporal, degrading gracefully with no embedder and needing no
external service; if impossible without a new dependency/network, leave the
interface inactive and stop.

Hard rules: REAL data only (no mocks); use the existing dependency-free apps/web
shell + control-API pattern (no framework/build tooling/runtime dep); local-first
only (no network/model API); reuse packages/protocol/src/fingerprint.mjs and
existing routes. Web-shell tests MUST assert the routes render real fact fields +
the real token number (a mock/broken UI must fail CI). Few high-value tests; never
weaken a test.

Checkpoint Protocol: focused tests -> npm run protocol:validate ->
node scripts/check.mjs -> npm run ci; commit per green; stop at first blocker
(write LOOP_WORKBENCH_BLOCKERS.md and report). When done, report each sub-goal's
commit + CI status and the demo's printed token-saving number.
```

## After the run — verification (UI needs eyes, not just CI)

CI-green proves the data wiring; it does NOT prove the UI looks right. After the
run: review the branch, then run the app and screenshot the `/memory` and
`/loop-workbench` routes to confirm the real data + token number actually render.
Then merge into the integration branch and proceed.
