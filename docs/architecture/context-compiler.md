# Context Compiler

## Purpose

The Context Compiler answers one question for every model call:

> Of everything this workspace could know, what is the smallest sufficient set this step should reason over now?

It is not a vector-search wrapper. It is a deterministic, versioned selection pipeline.

## Request contract

A request includes workspace, actor, task, step, objective, required IDs and entities, token budget, allowed scopes or data classes, time, and a task profile.

## Candidate-source boundary

OAF-010 introduces a provider-neutral candidate-source layer before the
existing compiler selection step. Candidate sources discover possible records;
trusted contextual policy filters source access and candidate data classes; the
candidate result preserves source hits, query fingerprints, access-decision
references, provenance, trust labels, and partial failure reports; then the
OAF-011 selector performs eligibility, scoring, conflict detection, token
budgeting, diversity, and final selection.

The committed source kinds are `exact`, `lexical`, `ast-code`, `vector`,
`graph`, `temporal`, `preference`, and `episode`. Native `exact`, `lexical`,
and dependency-free JS/TS `ast-code` sources are implemented and enabled in the
bootstrap. Future source kinds report `source_unavailable` when planned without
a provider. They are not successful empty providers.

Candidate sources must not perform hybrid fusion, global reranking, diversity
selection, reserved token budgeting, context assembly, model query expansion,
embedding lookup, graph traversal, browser automation, external search,
outbound network calls, persistent index writes, or adapter activation. Same
record ID plus same version/hash merges source hits deterministically; same ID
with conflicting version/hash fails closed as `candidate_identity_conflict`.

The native JS/TS source graph is a read-only derived index over the native
AST-code source index. It exposes files, chunks, symbols, modules, structural
edges, lexical graph search, call traces, and diff-impact reports for local
inspection and future context selection. It is not a `graph` candidate-source
provider yet, not canonical source or memory state, and not backed by a graph
database or external adapter.

## Selection policy

OAF-011 adds a strict internal selection policy contract at
`packages/protocol/schemas/context-selection-policy.schema.json` and a safe
selection-result trace at
`packages/protocol/schemas/context-selection-result.schema.json`. The policy is
versioned as `1.0.0`; its SHA-256 fingerprint is recorded on every internal
selection trace.

The selector uses weighted reciprocal rank fusion over provider-neutral source
hits. The native direct path receives a `direct` hit; source-backed candidates
use exact, lexical, or later declared source kinds. Local source scores are
diagnostic only and do not grant authority across arbitrary provider scales.

After fusion, the selector applies bounded feature weights for task relevance,
step relevance, entity and relation coverage, authority, confidence, preference
applicability, outcome evidence, temporal applicability, kind priority, and
token efficiency. Required IDs and governance records are selected first and
fail closed when unresolved, conflicting, or over budget. Optional candidates
must have task signal; high source rank alone cannot pull unrelated material
into the model context.

The diversity pass uses bounded MMR-style marginal utility over normalized
term shingles. Duplicate candidates are excluded as `redundant`; complementary
records receive coverage and kind bonuses. Category caps are enforced, and
category soft-reserve ratios are recorded in the policy as budget guidance for
governance, working state, decisions, preferences, evidence, procedures,
episodes, artifacts, negative evidence, examples, and other context. The
selector stops at the smallest sufficient set instead of filling the window.

`oaf context profile` uses the same selector for compressed memory injection.
Accepted active memory records are summarized into bounded static and dynamic
profile candidates, then selected under the normal context budget. The emitted
`contextBudget` reports local token estimates for delivered profile context
versus accepted memory history avoided; it is measurement evidence, not a
provider billing claim.

## Pipeline

1. **Authorize and normalize.** Remove inaccessible, malformed, quarantined, expired, retracted, and superseded candidates before ranking.
2. **Force governance.** Include applicable policies, hard constraints, output schema, current plan, unresolved obligations, and explicitly referenced records.
3. **Generate candidates.** Use source ports for exact references, lexical search, and dependency-free static JS/TS code evidence now; semantic, graph, temporal, preference, and episode sources are declared but unavailable until later tasks. Native source-graph helpers expose a bounded read-only CLI/API preview over the JS/TS source index, but they do not currently emit graph candidate-source records into model context.
4. **Resolve versions and conflicts.** Prefer active versions, preserve unresolved conflicts, and never silently merge contradictory values.
5. **Fuse and rerank.** Apply weighted reciprocal rank fusion, deterministic feature weights, and stable tie-breaks.
6. **Diversify and budget.** Select complementary records under token budget and category caps, with soft reserves recorded in policy.
7. **Order assembly.** Put durable constraints first, then deterministic reserved sections for negative context, decisions, preferences, procedures, evidence, episodes, artifacts, examples, other context, and working state.
8. **Persist manifest.** In durable composition, append the manifest before any model invocation, verify the stored copy, and emit a safe `context.manifest.persisted` event.
9. **Emit compatibility event.** Preserve `context.compiled` for existing run inspection with additive durable fields.

## Context Views

Some records are useful but too noisy to pass through verbatim, especially
logs, large JSON payloads, generated tool output, Markdown notes, and code
snippets where only anchors matter. OAF supports an explicit
`metadata.contextView.enabled` flag on input records to request a deterministic
local view before selection. The compiler never enables this silently.

The view builder classifies the content as JSON, log, code, Markdown, or text,
redacts secret-shaped values and private local paths, keeps high-signal lines,
and records `originalContentHash`, `viewContentHash`, original/view token
counts, reduction ratio, algorithm ID, content kind, and reason codes. The
selected manifest item keeps the original hash as `contentHash`, so the compact
view is recoverable by hash without treating the shortened text as canonical
state.

Context views are not a proxy, model reranker, embedding pass, vector store,
graph database, browser automation layer, or memory write path. They are a
bounded representation tier inside the existing Context Compiler. Token
accounting reports selected original tokens separately from assembled view
tokens and records context-view loss notes when a selected item was shortened.

## Persisted Assembly

OAF-012 keeps `compileContext(request, records)` synchronous and pure. Durable
callers use `compileAndPersistContext(...)`, which wraps the selector with
assembly and repository persistence.

The durable manifest records assembly policy version and fingerprint, ordered
sections, selected IDs in final model-input order, selected text exactly as
assembled, explicit representation tiers, selected-original and assembled token
counts, selected-token ratio, assembled-token ratio, excluded decisions without
raw text, token accounting, compiler version, selection fingerprints, source
warnings and failures, conflicts, a manifest `etag`, optional `deltaFrom`
summaries, and a manifest fingerprint. Unsafe local source paths are redacted
from durable source references before persistence.

`manifestFingerprint` is the SHA-256 over canonical manifest JSON excluding the
fingerprint field itself. `assemblyFingerprint` is the SHA-256 over the assembly
policy, section order, record IDs, selected content hashes, representation
hashes, and token estimates. Persistence failures stop before model invocation.

## Context-Use Feedback

OAF-018 records post-run feedback as references, not interpretations. A
context-use feedback record points at a persisted context manifest by ID and
fingerprint, lists each selected record in manifest order, marks whether the
record was observed as used, and links to sanitized outcome references. It does
not store raw prompts, raw outputs, context bodies, local paths, credentials, or
hidden reasoning.

Feedback summaries report use counts and outcome directions with
`causalClaim: none`. They measure association for diagnosis and regression
tests; they do not claim that a selected record caused an outcome.

Selector experiments compare a baseline policy fingerprint with a variant
policy fingerprint and are reversible to the baseline. A selector default
promotion returns a review-required plan only after a passing deterministic
evaluation report with zero regressions, context-use feedback evidence, and a
rollback plan. Assignment to an experiment arm does not mutate defaults.

## Required reason codes

Examples include `required`, `explicit_requirement`, `forced_governance`, `entity_coverage`, `source_fusion`, `task_relevance`, `entity_relation`, `high_authority`, `token_budget`, `redundant`, `secret_context_denied`, `superseded_by_newer_record`, `outside_valid_time`, and `insufficient_marginal_utility`.

## Failure conditions

- forced governance exceeds budget;
- required record is missing, inaccessible, or invalid;
- conflict policy requires human resolution;
- tokenization or source version is unavailable;
- a required candidate source is denied, unavailable, timed out, cancelled, failed, or returns invalid output;
- all candidate sources fail or are unavailable;
- a candidate source returns conflicting identity material for the same record ID;
- requested data class is prohibited;
- assembly cannot be reproduced.
- manifest persistence, verification, or identity conflict fails.

## Evaluation

Measure context precision, required-fact recall, distractor resistance, conflict handling, supersession accuracy, scope isolation, token efficiency, downstream task success, and stability across model changes. Never evaluate solely by filling a larger window.
