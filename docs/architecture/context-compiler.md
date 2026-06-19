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

The committed source kinds are `exact`, `lexical`, `vector`, `graph`,
`temporal`, `preference`, and `episode`. Only native `exact` and `lexical`
sources are implemented and enabled in the bootstrap. Future source kinds report
`source_unavailable` when planned without a provider. They are not successful
empty providers.

Candidate sources must not perform hybrid fusion, global reranking, diversity
selection, reserved token budgeting, context assembly, model query expansion,
embedding lookup, graph traversal, browser automation, external search,
outbound network calls, persistent index writes, or adapter activation. Same
record ID plus same version/hash merges source hits deterministically; same ID
with conflicting version/hash fails closed as `candidate_identity_conflict`.

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

## Pipeline

1. **Authorize and normalize.** Remove inaccessible, malformed, quarantined, expired, retracted, and superseded candidates before ranking.
2. **Force governance.** Include applicable policies, hard constraints, output schema, current plan, unresolved obligations, and explicitly referenced records.
3. **Generate candidates.** Use source ports for exact references and lexical search now; semantic, graph, temporal, preference, and episode sources are declared but unavailable until later tasks.
4. **Resolve versions and conflicts.** Prefer active versions, preserve unresolved conflicts, and never silently merge contradictory values.
5. **Fuse and rerank.** Apply weighted reciprocal rank fusion, deterministic feature weights, and stable tie-breaks.
6. **Diversify and budget.** Select complementary records under token budget and category caps, with soft reserves recorded in policy.
7. **Order assembly.** Put durable constraints first, then deterministic reserved sections for negative context, decisions, preferences, procedures, evidence, episodes, artifacts, examples, other context, and working state.
8. **Persist manifest.** In durable composition, append the manifest before any model invocation, verify the stored copy, and emit a safe `context.manifest.persisted` event.
9. **Emit compatibility event.** Preserve `context.compiled` for existing run inspection with additive durable fields.

## Persisted Assembly

OAF-012 keeps `compileContext(request, records)` synchronous and pure. Durable
callers use `compileAndPersistContext(...)`, which wraps the selector with
assembly and repository persistence.

The durable manifest records assembly policy version and fingerprint, ordered
sections, selected IDs in final model-input order, selected text exactly as
assembled, excluded decisions without raw text, token accounting, compiler
version, selection fingerprints, source warnings and failures, conflicts, and a
manifest fingerprint.

`manifestFingerprint` is the SHA-256 over canonical manifest JSON excluding the
fingerprint field itself. `assemblyFingerprint` is the SHA-256 over the assembly
policy, section order, record IDs, selected content hashes, and token estimates.
Persistence failures stop before model invocation.

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
