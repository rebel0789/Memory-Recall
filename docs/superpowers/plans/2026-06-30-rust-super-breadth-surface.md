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
3. Governed + local-first at RUNTIME: no cloud, no external DB, no EXTERNAL network. UI is 100% OFFLINE
   — assets compiled into the binary, ZERO CDN / external requests (cbm's UI broke offline via a
   troika-three-text CDN call, issue #453 — do NOT repeat that; vendor everything). External build-time
   crates/JS libs are fine (vendor + pin). Cloning repos for tests is fine. EXCEPTION (Phase A only): a
   LOCAL model — a localhost endpoint (Ollama-compatible) OR a bundled small model — is allowed when AI
   is EXPLICITLY enabled; localhost is not "external network." Default OFF; privacy preserved (nothing
   leaves the machine).
4. NEVER weaken/delete an assertion; NEVER game a benchmark (realistic baselines, real inputs, report
   failures, label methodology). Can't do it well → STOP and report (partial fine, faked/broken not).
5. No `unsafe` without justification + test. Commit per green build+test+gate.

## Phase A — Optional GOVERNED AI brain (small local model) — the "thinking buddy"
Give OAF an OPTIONAL self-contained thinking brain: a SMALL LOCAL model that helps organize and enrich
the governed graph — without ever becoming authority. This is OAF's unique combo (AI proposes, governance
decides); no other tool has it.
- Integration: when enabled (`--ai` flag / config + a local model: an Ollama-compatible localhost
  endpoint OR a bundled small GGUF via a vendored Rust llama/candle binding), OAF can call a small local
  model. DEFAULT OFF — with AI off, OAF behaves byte-identically to today (deterministic + host-agent
  skill); assert default-off parity (no model loaded, no localhost call). Pick a SMALL model (~1-3B) and
  keep inference OFF the hot query path (brain tasks only).
- GOVERNANCE INVARIANT (non-negotiable): every AI output goes through the proposal gate — PENDING, never
  auto-active; tagged provenance `ai_proposed` + an untrusted-grade trust_level so it cannot auto-commit
  (S3). The human/policy approves. Model output is NEVER authority.
- Brain tasks (all governed proposals): (a) graph organization — suggest community labels, entity
  aliases/merges, inferred relationships; (b) self-contained semantic extraction — extract governed facts
  from docs/conversations when no host-agent skill is driving (a local alternative to the skill); (c)
  entity/community summaries for the wiki; (d) conflict-resolution SUGGESTIONS for surfaced S4 conflicts
  (proposed, not auto-applied).
- Pluggable + honest: architecture must allow swapping the local backend; if a task's local-model quality
  is poor, report it honestly (graded) and keep the deterministic/skill path as the default.
GATE (`scripts/rust-ai-brain-quality.mjs`): run with AI enabled against a local test model (or a
deterministic stub backend) — assert AI-proposed facts are PENDING (never auto-active), carry
`ai_proposed` provenance + untrusted trust, require approval to activate; assert default-OFF is
byte-identical (no model load, no localhost request); report a graded quality sample (does the brain's
organization/extraction actually help). Commit: `feat: optional governed local AI brain`.

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
- [ ] Phase A: optional governed AI brain — AI proposals are PENDING/governed (never auto-active),
      default-OFF byte-identical, local-only; graded quality sample reported honestly.
- [ ] Phase L: a per-language precision/recall table + final count (honest, with any language stopped + why).
- [ ] Phase V: the redesigned `oaf ui` graph passes its gate — renders graph, search/filter/focus/detail/
      history all wired, governed encodings present, ZERO CDN/external requests; works on a real repo.
- [ ] Node `npm run ci` green (435) every checkpoint; only `/rust` + UI assets + harness scripts touched.
- [ ] Honest final report with everything stopped/unhandled/open.

## Reporting
End with: the per-language table + final count; the UI feature checklist + the offline proof (zero
external refs); the real-repo render results; the final harness/CI state; and an explicit "stopped /
unhandled / open questions" list. Real numbers only.
