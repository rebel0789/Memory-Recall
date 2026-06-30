# Codex SUPER-GOAL — OAF Breadth + Surface: almost-all-languages + best-in-class graph UI

Date: 2026-06-30. Owner: rebel. Runtime: VERY LONG autonomous (target many hours). Authoritative
design: `docs/product/oaf-rust-supertool-spec.md`. Predecessor: the banger (branch
`codex/rust-super-banger`, now merged to main). Verified Node OAF is the oracle. You (Codex) have
REASONING LATITUDE within each phase; the HARD RULES are non-negotiable.

## 0. Mission
Grow OAF's surface: support ALMOST ALL languages, and redesign `oaf ui` into the BEST governed graph
UI/visualization in the field — clean, fast, fully offline, with the governed/temporal features no
other tool has. Two phases, step by step, each gated + checkpoint-committed, honest-stop. Prove it on
real repos.

## HARD RULES (non-negotiable)
1. Base off `codex/rust-super-banger`. New worktree `codex/rust-super-surface`. Re-run ALL existing
   harnesses (M1-M9 + inspectable + CI-1..CI-7 + UI-1..UI-4 + banger lang/bench); ALL must pass before
   Phase L and AFTER every checkpoint (no regression).
2. Build isolation: `/rust` (+ in-binary UI assets) + new harness scripts only. NO other Node product
   files. `npm run ci` (435) green every checkpoint. Own CI job.
3. Governed + local-first at RUNTIME: no cloud, no external DB, no external network, and OAF ITSELF makes
   NO model calls. UI is 100% OFFLINE — assets compiled into the binary, ZERO CDN / external requests
   (cbm's UI broke offline via a troika-three-text CDN call, issue #453 — do NOT repeat that; vendor
   everything). External build-time crates/JS libs are fine (vendor + pin). Cloning repos for tests is
   fine. The "AI brain" (Phase A) is the HOST HARNESS's own LLM (GPT in Codex, Opus/Sonnet in Claude
   Code, etc.) driving OAF via the skill + MCP tools — OAF provides governed tools and never calls a
   model itself; this preserves no-model purity.
4. NEVER weaken/delete an assertion; NEVER game a benchmark (realistic baselines, real inputs, report
   failures, label methodology). Can't do it well → STOP and report (partial fine, faked/broken not).
5. No `unsafe` without justification + test. Commit per green build+test+gate.

## Phase A — Harness-LLM thinking brain (governed) + best-in-class auto-detection & setup
The "brain" is the HOST HARNESS's own LLM (GPT in Codex, Opus/Sonnet in Claude Code, the model in Cursor/
Gemini-CLI/etc.) — NOT a bundled or local model. OAF makes NO model calls; the host AGENT calls its own
model and drives OAF via the skill + MCP tools, and every result is routed through OAF's governed proposal
gate. This is OAF's unique combo: the harness's frontier model THINKS; OAF's governance DECIDES.

ALREADY EXISTS — EXTEND, do NOT rebuild: `skills/oaf-memory/SKILL.md` already implements the graphify
pattern (agent is the extractor) and is already token-smart (deterministic `ingest-docs`/AST/RI do the
bulk; the agent's LLM only fills semantic gaps; chunked; `memory consolidate` does ADD/UPDATE/DELETE/NOOP;
governed throughout). So the brain is largely DONE. The real NEW work in this phase is: (A.1) best-in-class
harness detection + one-command setup, and (A.2) EXTENDING that skill with explicit graph organization/
curation tasks. Keep A.0 token-smart as the law.

### A.0 TOKEN-SMART orchestration (governing principle — like graphify/graphiti; do NOT burn tokens)
The harness LLM is expensive. The brain must be SPARING and is the LAST resort, not the default:
- DETERMINISTIC-FIRST: do everything possible with NO LLM — tree-sitter AST (code), structural parsing
  (docs/ADR/transcript), RI semantic + BM25, graph queries, Louvain communities. Invoke the brain ONLY
  for what deterministic provably cannot do (rationale/WHY, cross-cutting organization, conflict-resolution
  judgement, NL summaries).
- INCREMENTAL: invoke the brain only on NEW/CHANGED content (reuse CI-6 incremental + content hashes);
  never re-process unchanged data (graphiti's episode model). Cache brain outputs keyed by content hash —
  identical input never re-calls.
- BATCHED + CHUNKED: when the LLM is used, batch/chunk the work into few large calls (graphify's parallel
  chunked extraction), not many small ones.
- CHEAP CONTEXT: build the LLM's prompt from OAF's OWN compact context (context-delta + targeted graph
  queries + the omission/provenance views) — feed minimal fact slices, NEVER raw whole files. Apply OAF's
  token-saver to its own brain.
- ACCOUNTED + BUDGETED: track and REPORT brain token usage per run; enforce a per-operation budget; a
  brain-assisted session must cost a small fraction of naive per-item LLM extraction. Report the number.

### A.1 Best-in-class detection + one-command setup (the "best easiest detection and setup" ask)
- `oaf setup` (and `oaf setup --detect`): AUTO-DETECT every installed coding-agent harness on the machine
  (Claude Code, Codex CLI, Cursor, Gemini CLI, VS Code/Copilot, Windsurf, Zed, Aider, Cline, Continue,
  etc.) by their config files / env / known paths — print exactly what was found.
- One command wires each detected harness: install the OAF MCP server entry + the oaf-memory skill +
  instruction snippet + (where supported) a pre-tool hook — RECEIPT-FIRST + `--confirm`, idempotent,
  exact uninstall, touches ONLY the agent's own config dirs, NO credential storage, NO external network
  (the M6 / UI-3 install discipline). Support a `--dry-run`. Detect AND report which model each harness
  uses (Codex→GPT, Claude Code→Opus/Sonnet, …) so the user sees which brain is linked.
### A.2 Governed brain tasks (driven by the harness LLM via skill + MCP)
Extend the oaf-memory skill + MCP tools so the host agent's model can: (a) ORGANIZE the graph — propose
community labels, entity aliases/merges, inferred relationships; (b) extract governed facts from docs/
conversations; (c) write entity/community summaries for the wiki; (d) propose conflict-resolution for
surfaced S4 conflicts. EVERY such output goes through the proposal gate — PENDING, never auto-active,
tagged provenance `ai_proposed` + untrusted trust (S3), requires approval. Model output is NEVER authority.
GATE (`scripts/rust-ai-brain-setup-quality.mjs`): on a temp fake multi-harness config dir, assert
detection lists the present harnesses correctly; `oaf setup --confirm` writes the MCP+skill entries with a
receipt, idempotently, touching ONLY those dirs, NO creds, NO network; assert a skill/MCP-driven brain
proposal (e.g. a graph-organization fact) lands PENDING/governed (ai_proposed, untrusted, needs approval),
and that OAF itself makes zero model calls. TOKEN-SMART assertions (A.0): assert the brain is NOT invoked
for tasks the deterministic path handles (a code-only / unchanged ingest triggers ZERO brain calls);
assert caching (identical brain input does not re-call); assert incremental (only changed content can
trigger the brain); assert brain token usage is tracked + reported + within a budget, and is a small
fraction of a naive per-item baseline. Commit: `feat: harness detection + token-smart governed brain`.

## Phase L — Almost all languages
Extend governed tree-sitter ingest toward broad coverage (currently ~17). Use your judgement to add as
many as you can do WELL — target a large set including the ones stopped before that need DEEPER AST/
call semantics (Haskell, Elixir, Erlang, Perl, OCaml, Clojure) plus more common/relevant ones (Groovy,
F#, Nim, Crystal, Vala, Tcl, Fortran, Solidity, Protobuf, GraphQL schema, Terraform/HCL, Markdown-as-
structure, etc.). For EACH: vendored grammar; extract File/Module/Function/Class/Method + DEFINES/
IMPORTS/CALLS (CALLS→Function/Method, NEVER Module); a per-language conformance fixture asserting
precision/recall + dedup + no silent truncation. STOP at any language you can't do well (report it,
don't degrade or fake the fixture). Report the per-language table, the final count, and binary-size growth.
GATE: every added language has a passing fixture; the real multi-language repo check still passes.

## Phase V — Best-in-class governed graph UI (redesign `oaf ui`) — THE main ask
Study cbm's `graph-ui` (React + Three.js 3D force "galaxy") clean-room for the visualization technique;
study common best practices (force-directed layout, d3-force / a vendored force-graph lib, cytoscape).
Then REDESIGN `oaf ui`'s graph surface to be the best — readable, fast, governed, and 100% offline.
Requirements:
- Interactive force-directed graph: a clean, readable 2D default AND an optional 3D mode. Vendor the
  rendering lib (e.g. a self-contained force-graph build) into the binary — NO CDN, NO external fetch.
- Visual encoding: node color by type (file/function/class/module/route/decision/entity), size by
  degree, Louvain community as cluster color; edges labeled by predicate, directional.
- Interaction: smooth zoom/pan; search + filter (by name/type/language/community); click a node →
  focus its k-hop neighborhood AND open a DETAIL PANEL showing its facts, provenance (`memory why`
  chain), trust level, and supersession history.
- GOVERNED/TEMPORAL features (our differentiators — no other tool's UI has these): current-vs-history
  toggle (reveal superseded nodes/edges, styled faded); governed-decision highlighting; conflict
  markers (surfaced S4 conflicts); trust-level indicators (untrusted nodes visually flagged).
- Layout: a clean modern shell — sidebar (search / filters / legend) + main graph canvas + a
  collapsible detail panel. Link to the wiki (/wiki) and architecture overview.
- Read-only; served by `oaf ui` from compiled assets; localhost only.
GATE (`scripts/rust-graph-ui-quality.mjs`): serve `oaf ui` over the OAF self-ingest graph; assert the
served bundle renders the graph (nodes/edges/communities present in the payload), search + filter +
click-focus + current/history toggle + detail-panel provenance are wired, governed-decision +
conflict + trust encodings present, and ZERO outbound/CDN/external-URL references in the served HTML/JS.
Include a DOM/asset check (parse the served HTML/JS for the required controls + zero external origins).
Commit: `feat: redesign governed graph ui` (+ per-feature commits).

## Phase real-repo proof (fold into both phases)
Ingest ≥2 real public repos and render their graphs in the redesigned UI; confirm the new languages
extract on real code and the UI renders a real, non-trivial graph offline. Report honest numbers.

## DEFERRED (do NOT build): cloud-hosted UI, real-time collaboration, signing/packaging pipeline,
image/OCR. Out of scope.

## Definition of done
- [ ] Based on banger branch; ALL prior harnesses still pass before Phase A and after every checkpoint.
- [ ] Phase A: harness auto-detection lists installed agents + their models; `oaf setup` wires MCP+skill
      receipt-first/idempotent/no-creds/no-network; brain proposals (harness-LLM driven) land PENDING/
      governed (ai_proposed, untrusted, needs approval); OAF makes zero model calls.
- [ ] Phase L: a per-language precision/recall table + final count (honest, with any language stopped + why).
- [ ] Phase V: the redesigned `oaf ui` graph passes its gate — renders graph, search/filter/focus/detail/
      history all wired, governed encodings present, ZERO CDN/external requests; works on a real repo.
- [ ] Node `npm run ci` green (435) every checkpoint; only `/rust` + UI assets + harness scripts touched.
- [ ] Honest final report with everything stopped/unhandled/open.

## Reporting
End with: the per-language table + final count; the UI feature checklist + the offline proof (zero
external refs); the real-repo render results; the final harness/CI state; and an explicit "stopped /
unhandled / open questions" list. Real numbers only.
