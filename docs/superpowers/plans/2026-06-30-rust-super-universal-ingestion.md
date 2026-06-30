# Codex SUPER-GOAL — OAF Universal Governed Ingestion + Knowledge Surface (UI-1 → UI-4)

Date: 2026-06-30. Owner: rebel. Runtime: LONG autonomous (overnight, many hours).
Authoritative design: `docs/product/oaf-rust-supertool-spec.md`. Predecessor: the code-intel
campaign (branch `codex/rust-super-code-intel`). Verified Node OAF is the oracle.

## 0. Mission
Make OAF a SUPERSET of supermemory + mem0 + graphiti + graphify — but governed and local-first.
Today OAF only ingests CODE. This campaign lets it ingest docs, decisions, PDFs, agent/chat
transcripts, and local connectors into the SAME governed/bi-temporal memory, and surface it as a
browsable knowledge wiki. Four sequenced milestones, each gated + checkpoint-committed, honest-stop.

## CORE PRINCIPLE (read — this is how we differ from those tools)
mem0/graphiti/supermemory all rely on a BUILT-IN LLM for extraction and a cloud/external DB.
OAF does NOT. Our model:
- **Deterministic structural extraction** (built into the Rust binary): markdown structure, ADR
  fields, transcript message roles, PDF text — parsed into candidate facts with provenance.
- **Semantic extraction = the host-agent SKILL** (the existing `oaf-memory` skill pattern: the
  agent reads the source and emits a governed facts.json). NO built-in model.
- **Consolidation + storage = OAF's governed core** (proposal gate, supersession, dedup, conflict
  surfacing, provenance, trust) — which already maps onto mem0's ADD/UPDATE/DELETE/NOOP.
So: we provide the plumbing + consolidation natively; the skill provides the intelligence; every
fact is governed/auditable. Local-first, no cloud, no required model.

## HOW TO COOK (study, clean-room)
For each milestone, study the named references to learn the technique, then reimplement clean-room
on OAF's governed model (do not copy; attribute in THIRD_PARTY):
- mem0 (github mem0ai/mem0): extract→consolidate, ADD/UPDATE/DELETE/NOOP operations.
- graphiti (github getzep/graphiti): bi-temporal KG + hybrid retrieval + episodes (we have most).
- graphify (IN-REPO: `.claude/skills/graphify/references/extraction-spec.md`): chunked extraction,
  confidence rubric, wiki/index generation.
- supermemory: connector model (we do LOCAL connectors only — no cloud).

## GLOBAL RULES
- Base off `codex/rust-super-code-intel`. New worktree `codex/rust-super-ingestion`. Re-run ALL
  existing harnesses; M1-M9 + inspectable + CI-1..CI-7 must pass before UI-1.
- Governed: every ingested fact goes through the proposal gate; carries provenance (source + locator
  + location) + trust_level; never hard-delete; sanitizer blocks secrets/paths.
- Local-first, no network at runtime (except an explicit local connector the user invokes, e.g. the
  user's own `gh`), no built-in model. No `unsafe` without justification+test.
- Build isolation: `/rust` + new harness scripts (+ the oaf-memory skill doc, which is not a Node
  product file). `npm run ci` (435) green every checkpoint. Own CI job.
- Conformance: existing surfaces byte-parity on pre-existing fields; new surfaces quality-verified on
  REAL inputs. NEVER weaken an assertion. Checkpoint per green build+test+gate. HONEST-STOP: do each
  WELL, stop at the first you can't and report why. DON'T OVERCOOK.

---

## UI-1 — Multi-source governed ingestion (docs / markdown / ADR / PDF / text)
Technique: add source parsers that turn non-code files into GOVERNED candidate facts:
- Markdown: parse headings→sections, lists, code blocks, links; emit facts {subject=doc id,
  predicate=`section`/`heading`/`mentions`, object=normalized text/title} + provenance (file + line
  range). Treat append-only decision logs / ADR templates specially: extract status/context/decision/
  consequences fields → governed `decision` facts (with supersession when a later ADR overrides one).
- PDF: extract text via a vendored Rust crate (e.g. `lopdf`/`pdf-extract`); index text + section
  structure (no images/OCR — defer). Plain text: paragraph/line facts.
- Semantic depth via the SKILL: extend the `oaf-memory` skill so the host agent can read a doc set and
  emit governed facts.json (decisions, rationale, relationships) → proposal gate. (Reuse the verified
  skill flow; this is the graphify "agent is the extractor" pattern.)
- `oaf ingest-docs --root <dir>` (or extend `oaf ingest` with `--docs`). Sanitize; provenance; trust.
GATE (`scripts/rust-docs-ingest-quality.mjs`): ingest OAF's own `docs/` (markdown + ADRs); assert
section + decision facts created with correct provenance, a superseding ADR retires the old decision,
recall/`memory why` find them, secrets/paths skipped with reasons. Commit: `feat: multi-source doc ingestion`.

## UI-2 — Conversational memory (mem0's technique, governed) — the distinctive one
Technique (mem0 extract→consolidate, but governed + no built-in model):
- Parse an agent/chat transcript (JSON/markdown: messages with roles user/assistant/tool, timestamps).
  Structural pass extracts candidate statements; the SKILL extracts salient memory candidates
  (preferences, decisions, constraints, corrections) → governed facts.json with provenance (message id).
- CONSOLIDATION (implement natively — this is mem0's update phase, we have the pieces): for EACH
  candidate, use CI-1 semantic + (subject,predicate) match to retrieve the top-similar EXISTING active
  facts, then decide an operation:
    ADD   — no semantically-equivalent fact exists → new proposal.
    UPDATE— augments/refines an existing fact → supersede the old (governed, history kept).
    DELETE— contradicts an existing fact → supersede old to inactive (NEVER hard-delete).
    NOOP  — duplicate/no change → skip (record skippedDuplicate).
  Emit a consolidation receipt {candidate, operation, matched_fact_id, reason}. All proposal-gated;
  conflicts that aren't clear UPDATE/DELETE are SURFACED (S4), not auto-resolved.
- Scope-aware (user/session/project). Transcript content is `untrusted_external` trust by default
  (can propose, not auto-commit — S3).
GATE (`scripts/rust-conversational-quality.mjs`): a fixture transcript where the user states a
preference, later REFINES it (→UPDATE/supersede), later CONTRADICTS it (→DELETE/supersede-inactive),
and restates one verbatim (→NOOP); assert the operations chosen are correct, current truth = latest,
full history via `memory why`, all governed. Commit: `feat: governed conversational memory (mem0-style consolidation)`.

## UI-3 — Local connectors (supermemory's connectors — LOCAL only, no cloud)
Technique: source adapters that read from LOCAL/user-authorized sources and route through UI-1/UI-2:
- a docs folder; a Notion/Obsidian markdown export; GitHub issues/PRs for a repo via the user's own
  `gh` CLI (read-only, uses existing local auth — NO stored credentials, NO new network endpoints);
  a chat-export file. Each adapter = source → candidate facts → governed ingestion (UI-1/UI-2 path).
- Hard rules: NO cloud API, NO credential storage, NO network beyond the explicit local tool the user
  invokes; every connector run shows a receipt of what it will ingest (proposal-gated, never silent).
GATE (`scripts/rust-connectors-quality.mjs`): a folder connector ingests a local doc dir; a `gh`
connector ingests issues for a test repo (or a recorded fixture if offline) → governed facts with
provenance; assert no credentials stored, no unexpected network, receipt shown. Commit: `feat: local governed connectors`.

## UI-4 — Knowledge wiki / browsable surface (graphify's wiki)
Study: the in-repo graphify spec + its wiki/index idea.
Technique: generate a browsable knowledge surface from the governed graph: an index page; per-entity
pages (its facts, provenance, neighbors, supersession history); per-community pages (Louvain clusters
from CI/M4); a decisions page (governed `decision`/`adr` facts, current + superseded). Current-truth by
default with a history toggle. Serve from the existing offline graph UI (`oaf ui`) — 100% offline, no CDN.
GATE (`scripts/rust-wiki-quality.mjs`): generate the wiki for the OAF self-ingest (code + docs); assert
an index + entity pages + community pages + decisions page exist, internal links resolve, current-truth
shown with provenance, ZERO outbound/CDN requests. Commit: `feat: governed knowledge wiki surface`.

## DEFERRED (do NOT build): cloud/hosted API, external vector/graph DB (Neo4j/Falkor), required LLM,
image/OCR ingestion, real-time streaming sync. These are anti our local-first/no-model differentiator
or large scope — revisit only if explicitly prioritized.

---

## Definition of done (per milestone + overall)
- [ ] Based on code-intel branch; M1-M9 + inspectable + CI-1..CI-7 still pass before UI-1 and after EACH.
- [ ] Each completed milestone: gate passes; existing surfaces byte-parity on pre-existing fields; new
      surfaces quality-verified on REAL inputs; provenance + trust on every ingested fact; THIRD_PARTY
      attributes mem0/graphiti/graphify; checkpoint committed.
- [ ] Node `npm run ci` green (435) every checkpoint; only `/rust` + harness scripts (+ skill doc) touched.
- [ ] Honest report per milestone (numbers + unhandled) and explicit note if a milestone was STOPPED.

## Reporting
End with: per-milestone status (done / stopped-with-reason), each gate's numbers (esp. UI-2
operation-decision correctness ADD/UPDATE/DELETE/NOOP, UI-1 decision-supersession, UI-4 wiki coverage +
offline proof), THIRD_PARTY attributions, final harness/CI state, and an explicit "stopped / unhandled /
open questions" list. Real numbers only.
