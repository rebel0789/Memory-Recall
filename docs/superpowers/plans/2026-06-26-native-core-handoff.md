# Native Core — Codex Handoff Plan (local-first, best-of-breed memory)

Goal of this plan: make OAF's **native core best-in-class** — better than any
external organ — for the **local-first single-developer** production target.
SQLite is the production database. External systems (Postgres, Temporal,
graphiti, mem0, supermemory) stay **optional, disabled-by-default organs users
install as needed**. Never required.

Each goal below is a self-contained Codex handoff: fire it, walk away, it commits
per the checkpoint protocol. All goals obey the **Unattended Run Rules** and
**Checkpoint Protocol** in
[loop-workbench-build-plan.md](../../product/loop-workbench-build-plan.md)
(Sections 2 and the super-goal checkpoint rule): one item at a time, reuse before
writing, commit only when `npm run ci` is green, never weaken a test, stop at the
first blocker.

Fire them in order. **G0 is already DONE** on branch `codex/native-cleanup`
(see `CLEANUP_REPORT.md`): the audit found little safe dead code, removed the two
genuinely-orphaned helpers, and proved the utility "duplication" is mostly UNSAFE
to merge (the copies diverged — `sha256` alone has 5 different behaviors). **Base
every goal below on the merged `codex/native-cleanup` branch.**

Status: G0 ✅ done · G0.5 → G7 pending.

---

## Design: what "best-of-breed native core" means

Synthesis of graphify + graphiti + supermemory + mem0, implemented natively on
SQLite + FTS5 + sqlite-vec — no external service required, graceful degradation
when no local model is present.

```text
ingest  -> bi-temporal SQLite store -> hybrid fusion retrieval -> compressed
           (facts+episodes)             (FTS5 + vec + graph +     profile/context
                                          temporal rank)           injection
                                              |                        |
                                         supersession +          measured token
                                         temporal decay          budget (the win)
```

Best ideas adopted natively:

- **Bi-temporal facts (graphiti):** each fact has `validFrom`, `validUntil`,
  `supersededBy`, and an `episodeId` provenance link. Contradictions invalidate,
  never delete.
- **ADD-only extraction (mem0):** one extraction pass appends facts; old facts
  rank lower by time, not by deletion. Entity linking across facts.
- **Memory ≠ RAG + compressed profile (supermemory):** extract facts about the
  user/project, maintain a dual-layer profile (static long-term + dynamic recent),
  inject a compact profile instead of replaying history. This is the largest token
  saving and must carry a measured `contextBudget`.
- **Hybrid multi-signal retrieval (graphiti + mem0):** FTS5 keyword + sqlite-vec
  semantic + graph/entity traversal + temporal ranking, fused.
- **Scoped graph + digests (graphify):** community/god-node summaries for
  token-cheap context; query/path/explain over memory + source graph.
- **Multi-scope (mem0):** workspace / session / agent / user memory scopes.

Local-first honesty constraints:

- **No external service required.** FTS5 + graph always work offline. sqlite-vec
  semantic search activates only when a local embedder is available (loopback
  Ollama or a small local model); otherwise the system **degrades gracefully** to
  keyword + graph + temporal. State this in limitations.
- **Extraction is proposal-gated** (OAF rule): extraction proposes facts; nothing
  becomes durable memory without the proposal gate. Heuristic extraction in
  offline mode; better with a local model. No automatic permanent memory.
- **Never hard-delete** memory: supersession + decay ranking only, for audit.
- **No cloud fallback, no network, no provider keys** in the native path.

---

## G0 — Full cleanup / de-bloat ✅ DONE (branch codex/native-cleanup)

- **Objective:** remove over-engineered, duplicated, and dead code without
  changing real behavior. The codebase grew through many agent runs and has
  accumulated redundancy (e.g. many near-duplicate context-pack CLI variants and
  helper paths). Shrink it safely.
- **Method (audit, then remove with evidence):**
  1. Build an inventory: list CLI subcommands, exported helpers in
     `packages/harness-context/src/index.mjs`, and protocol schemas. Find
     near-duplicates (same logic, slightly different wrapper) and unreferenced
     exports (Grep for each symbol; zero non-test callers = candidate).
  2. For each removal candidate, confirm no production caller and that a test (if
     any) covers behavior that is preserved elsewhere. Remove dead code,
     collapse duplicate helpers into one, delete redundant CLI variants that are
     strict subsets of another.
  3. Do NOT remove anything with a real caller or unique tested behavior. When in
     doubt, leave it and note it in `CLEANUP_REPORT.md`.
- **DoD:** net negative line count; `CLEANUP_REPORT.md` lists what was removed and
  why; `npm run ci` green; no public behavior change (all existing tests still
  pass unmodified — do NOT delete tests to enable a removal; if a test fails, the
  removal was unsafe, revert it).
- **Boundaries:** behavior-preserving only. No new features. No test deletion to
  force a pass. Keep `CLAUDE.md` / `.claude/` untouched.
- **Attach prompt:**
  ```text
  You are working in Open Agent Fabric. Obey the Unattended Run Rules + Checkpoint
  Protocol in docs/product/loop-workbench-build-plan.md. Base on the merged loop
  workbench branch; worktree codex/native-cleanup.

  Do G0 from docs/superpowers/plans/2026-06-26-native-core-handoff.md: a
  behavior-preserving cleanup. Inventory CLI subcommands, exported helpers, and
  schemas; find near-duplicates and unreferenced exports (Grep each symbol; zero
  non-test callers = candidate). Remove dead code, collapse duplicate helpers,
  delete redundant CLI variants that are strict subsets of another — ONLY when no
  production caller exists and behavior is preserved elsewhere. Never delete a test
  to enable a removal; if an existing test fails, revert that removal. Produce
  CLEANUP_REPORT.md. Target net-negative lines. Commit per green step. Stop when
  npm run ci is green with no behavior change.
  ```

---

## G0.5 — Reconcile + unify divergent utilities (corrected, fingerprint-safe)

- **Why corrected:** the G0 audit proved the duplicated helpers have **diverged**,
  so a blind dedup would change fingerprints/validation. `sha256` has 5 distinct
  behaviors across 9 copies; `stableStringify` has 3 across 6; `assertPlainObject`
  has 4 distinct across 4; only `canonicalStringify` (×3) is byte-identical. See
  `CLEANUP_REPORT.md` for the full divergence map.
- **Objective:** unify these into one shared module **without changing any digest
  or validation outcome**.
- **Method:** for each helper, (1) pick one canonical implementation, (2) confirm
  every caller's actual input types are compatible with it, (3) add
  fingerprint-equivalence tests over representative inputs (including non-string
  inputs for `sha256`) proving digests are unchanged, (4) then move it to a shared
  module under `packages/protocol/src/` (the base packages already import via
  `../../protocol/...`) and replace the copies. Start with the trivially-safe
  `canonicalStringify`; treat `sha256`, `stableStringify`, `assertPlainObject` as
  behavior-sensitive and do each behind its own equivalence test.
- **DoD:** copies removed; all callers import the shared helper; new
  fingerprint-equivalence tests pass; `npm run ci` green; zero digest changes.
- **Boundaries:** no digest/validation behavior change. If a caller's behavior
  would change, keep that variant local and document why — do not force a merge.
- **Attach prompt:**
  ```text
  You are working in Open Agent Fabric. Obey the Unattended Run Rules + Checkpoint
  Protocol in docs/product/loop-workbench-build-plan.md. Base on merged
  codex/native-cleanup; worktree codex/native-utils.

  Do G0.5 from docs/superpowers/plans/2026-06-26-native-core-handoff.md: unify the
  divergent duplicated utilities WITHOUT changing any fingerprint. Read
  CLEANUP_REPORT.md for the divergence map. For each helper (start with the
  byte-identical canonicalStringify; then sha256, stableStringify,
  assertPlainObject which are behavior-sensitive): pick one canonical impl, confirm
  caller input types are compatible, add fingerprint-equivalence tests over
  representative inputs INCLUDING non-string inputs, then move it to
  packages/protocol/src/ and replace the copies. If unifying would change any
  digest or validation outcome, keep that variant local and document why. One
  focused test file. Commit per green step. Stop when npm run ci is green with zero
  digest changes.
  ```

---

## G1 — Fix Loop Workbench review findings + command-exec security model

- **Objective:** resolve the 7 code-review findings on the loop workbench before
  building the new core on top of it.
- **Required fixes:**
  1. **Security (#1):** `loop observe/verify/run` execute the plan's
     `validationCommands` from a file. Remove the misleading `--read-only` flag
     from these three subcommands; require explicit opt-in to run commands; run
     only commands matching a safe allowlist prefix (`node --test`, `npm test`,
     `npm run …`) or confirmed once. Arbitrary commands from an untrusted plan are
     rejected by default.
  2. **Safety (#2):** route command-output redaction through the strict
     `assertSafeHandoffField` pattern set (add `HANDOFF_ABSOLUTE_PATH` coverage to
     command output) so `/home`, `/private`, `/var/folders`, and Windows paths
     cannot leak into `outputSummary`.
  3. **Bug (#4):** `gitChangedWorkspaceLocators` must classify forbidden-root /
     git-quoted paths as out-of-scope instead of throwing and aborting
     verification.
  4. **Bug (#5):** sanitize/normalize `reasonCodes` from upstream usePlan/
     contextPack before schema validation.
  5. **Bug (#6):** fix the `?? ` empty-array suppression so an empty
     `usePlan.requiredLocalReads` does not drop contextPack reads.
  6. **Bug (#7):** compute the observation event id after the final
     `observationFingerprint` so id matches its payload.
  7. **Coverage (#8):** add CLI invocation tests for observe/verify/run/schedule
     asserting the new command-exec gate and `--write`/`--merge` rejection.
- **DoD:** each fix has a test; `npm run ci` green.
- **Attach prompt:**
  ```text
  You are working in Open Agent Fabric. Obey the Unattended Run Rules + Checkpoint
  Protocol in docs/product/loop-workbench-build-plan.md. Base on the merged loop
  workbench branch; worktree codex/loop-workbench-fixes.

  Do G1 from docs/superpowers/plans/2026-06-26-native-core-handoff.md: fix the 7
  review findings. Most important: (a) drop the --read-only flag from loop
  observe/verify/run and gate command execution behind an explicit opt-in +
  allowlist (node --test, npm test, npm run *) — reject arbitrary commands from a
  plan file by default; (b) route command-output redaction through
  assertSafeHandoffField so absolute paths on Linux/Windows cannot leak. Then fix
  bugs #4-#7 and add CLI invocation tests (#8). Each fix gets a test. Commit per
  green step. Stop when npm run ci is green.
  ```

---

## G2 — Native bi-temporal memory store (SQLite)

- **Objective:** the graphiti/supermemory temporal model, native on SQLite+FTS5.
- **Adds:** `fact`, `entity`, `edge`, `episode` tables with bi-temporal fields
  (`validFrom`, `validUntil`, `supersededBy`, `episodeId`), FTS5 index, multi-scope
  (`workspace`/`session`/`agent`/`user`). Supersession: a new contradicting fact
  marks the old `validUntil` + `supersededBy`, never deletes.
- **New artifacts:** memory schema(s) in `packages/protocol/schemas/`; store
  helpers in `packages/memory-core` + `providers/native/memory-sqlite`; `oaf
  memory fact add/get/history` CLI; fixtures; one focused test.
- **Reuses:** existing SQLite memory provider, proposal gate, hash/fingerprint,
  schema validator.
- **DoD:** add a fact, supersede it, query "what was true at time T" vs "now";
  provenance resolves to an episode; proposal gate enforced; `npm run ci` green.
- **Boundaries:** proposal-gated, no hard delete, no external service, no model
  required for storage.
- **Attach prompt:**
  ```text
  You are working in Open Agent Fabric. Obey the Unattended Run Rules + Checkpoint
  Protocol in docs/product/loop-workbench-build-plan.md. Base on merged G1; worktree
  codex/native-memory-temporal.

  Do G2 from docs/superpowers/plans/2026-06-26-native-core-handoff.md: implement a
  bi-temporal memory store on SQLite (graphiti/supermemory model) in memory-core +
  providers/native/memory-sqlite. Facts/entities/edges/episodes with
  validFrom/validUntil/supersededBy/episodeId, FTS5 index, scopes
  workspace/session/agent/user. Supersession marks old facts invalid, never
  deletes. Add `oaf memory fact add/get/history`. Proposal-gated, no hard delete,
  no external service. One focused test (add, supersede, time-travel query,
  provenance). Commit per green step. Stop when npm run ci is green.
  ```

---

## G3 — Hybrid fusion retrieval (FTS5 + sqlite-vec + graph + temporal)

- **Objective:** multi-signal retrieval from graphiti + mem0, native + offline-safe.
- **Adds:** a retriever that fuses FTS5 keyword (BM25-style), sqlite-vec semantic
  (when a local embedder is available, else skipped), graph/entity traversal, and
  temporal ranking; plus graphify-style scoped subgraph + community/god-node
  digests over the memory graph and source graph. `oaf memory search` +
  `oaf memory path/explain`.
- **Reuses:** native source graph (graphify-style), FTS5 memory provider, the
  loopback Ollama provider for optional embeddings.
- **DoD:** hybrid search returns fused, temporally-ranked results; degrades to
  keyword+graph when no embedder; scoped digest is smaller than raw results
  (measured); `npm run ci` green.
- **Boundaries:** graceful degradation, no external service required, no network.
- **Attach prompt:**
  ```text
  You are working in Open Agent Fabric. Obey the Unattended Run Rules + Checkpoint
  Protocol in docs/product/loop-workbench-build-plan.md. Base on merged G2; worktree
  codex/native-hybrid-retrieval.

  Do G3 from docs/superpowers/plans/2026-06-26-native-core-handoff.md: hybrid fusion
  retrieval over the bi-temporal store — FTS5 keyword + sqlite-vec semantic (only
  when a local embedder is available, else skip) + graph/entity traversal +
  temporal ranking, fused into one ranked list. Add graphify-style scoped subgraph
  + community/god-node digests, and `oaf memory search/path/explain`. Must degrade
  gracefully with no embedder and need no external service. One focused test
  (fusion ranking, graceful degradation, digest is smaller than raw — measured).
  Commit per green step. Stop when npm run ci is green.
  ```

---

## G4 — Fact extraction (ADD-only, proposal-gated) + entity linking

- **Objective:** mem0's ADD-only single-pass extraction + supermemory's
  fact-not-chunk approach, proposal-gated.
- **Adds:** extract salient facts from an interaction/episode in one pass (append
  only; never overwrite), link entities across facts, write to the proposal queue
  (not active memory). Heuristic extraction offline; better with a local model.
- **Reuses:** proposal gate, the bi-temporal store (G2), entity model.
- **DoD:** extraction proposes facts with provenance + entity links; nothing
  becomes durable without proposal approval; deterministic in offline mode;
  `npm run ci` green.
- **Boundaries:** proposal-only, no auto-activation, no required model, no network.
- **Attach prompt:**
  ```text
  You are working in Open Agent Fabric. Obey the Unattended Run Rules + Checkpoint
  Protocol in docs/product/loop-workbench-build-plan.md. Base on merged G3; worktree
  codex/native-extraction.

  Do G4 from docs/superpowers/plans/2026-06-26-native-core-handoff.md: ADD-only
  single-pass fact extraction (mem0 style) that proposes facts to the proposal
  gate with provenance + entity links — append only, never overwrite, never
  auto-activate. Heuristic/deterministic offline; better with optional local
  model. One focused test (extraction proposes, proposal gate blocks
  auto-activation, deterministic offline). Commit per green step. Stop when npm run
  ci is green.
  ```

---

## G5 — Compressed profile + context compilation (the token win)

- **Objective:** supermemory's dual-layer profile injection wired into OAF's
  Context Compiler, with a measured token budget — the headline token saving.
- **Adds:** a compiler that builds a compact profile (static long-term facts +
  dynamic recent context) plus the smallest-sufficient retrieved context, instead
  of replaying history; emits a `contextBudget` (estimated delivery tokens,
  history tokens avoided, reduction ratio). `oaf context profile`.
- **Reuses:** Context Compiler, the loop-plan `contextBudget` idiom, hybrid
  retrieval (G3).
- **DoD:** profile is bounded and compact; `contextBudget` shows measured
  reduction vs full history; deterministic; `npm run ci` green.
- **Boundaries:** read-only, measured savings only (no unproven claims), no model
  required to assemble the profile from stored facts.
- **Attach prompt:**
  ```text
  You are working in Open Agent Fabric. Obey the Unattended Run Rules + Checkpoint
  Protocol in docs/product/loop-workbench-build-plan.md. Base on merged G4; worktree
  codex/native-profile.

  Do G5 from docs/superpowers/plans/2026-06-26-native-core-handoff.md: a compressed
  dual-layer profile (static + dynamic) + smallest-sufficient context via the
  Context Compiler, replacing history replay. Emit a measured contextBudget
  (delivery tokens, history tokens avoided, reduction ratio). Add `oaf context
  profile`. Read-only, deterministic, measured savings only. One focused test
  (profile bounded, budget shows real reduction, deterministic). Commit per green
  step. Stop when npm run ci is green.
  ```

---

## G6 — Skills + reasoning refinement

- **Objective:** finalize the two skills + maker/checker reasoning already
  scaffolded, to ponytail/mattpocock quality.
- **Adds:** the reuse-before-generate action skill (ponytail laziness ladder) and
  the intent-clarification grilling skill, each with focused behavior; tie the
  maker/checker reasoning + stop conditions into the loop run.
- **DoD:** skills are model-invocable, documented, tested; `npm run ci` green.
- **Attach prompt:**
  ```text
  You are working in Open Agent Fabric. Obey the Unattended Run Rules + Checkpoint
  Protocol in docs/product/loop-workbench-build-plan.md. Base on merged G5; worktree
  codex/native-skills.

  Do G6 from docs/superpowers/plans/2026-06-26-native-core-handoff.md: finalize the
  reuse-before-generate action skill (ponytail laziness ladder) and the
  intent-clarification grilling skill to production quality, and wire maker/checker
  reasoning + stop conditions into the loop run. One focused test per skill. Commit
  per green step. Stop when npm run ci is green.
  ```

---

## G7 — Local-first production polish

- **Objective:** declare the native core production-ready for the local profile.
- **Adds:** end-to-end tests across plan→memory→retrieval→profile→loop;
  one-command install/run; harden the existing local-owner auth; honest
  `PROJECT_STATUS.json` bump for the local profile; updated docs.
- **DoD:** e2e green; clean install path; honest status; `npm run ci` green.
- **Boundaries:** local-first only; do not claim team/cloud production.
- **Attach prompt:**
  ```text
  You are working in Open Agent Fabric. Obey the Unattended Run Rules + Checkpoint
  Protocol in docs/product/loop-workbench-build-plan.md. Base on merged G6; worktree
  codex/native-production-polish.

  Do G7 from docs/superpowers/plans/2026-06-26-native-core-handoff.md: end-to-end
  tests across plan->memory->retrieval->profile->loop, a one-command install/run
  path, hardened local-owner auth, and an honest PROJECT_STATUS bump for the
  LOCAL-FIRST profile only (do not claim team/cloud production). Update docs. Commit
  per green step. Stop when npm run ci is green.
  ```

---

## After G7 — optional organs (only when a user needs them)

Each is a disabled-by-default, conformance-gated adapter behind an existing port,
installed via `oaf adapter enable <name>`. The native core never depends on them:

- **graphiti** / **Neo4j-FalkorDB** — temporal graph memory at scale.
- **mem0** / **Qdrant** — managed memory + vector DB.
- **supermemory** — hosted memory + connectors.
- **Postgres + pgvector** — team/multi-user concurrency + vectors.
- **Temporal** + **Pydantic AI** — durable workflow + typed runtime at scale.
- **OpenTelemetry** — production observability.

These are the path from local-first production to team/cloud — additive, never a
rewrite.
