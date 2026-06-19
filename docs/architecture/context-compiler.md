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
existing compiler performs eligibility, scoring, conflict detection, token
budgeting, and selection.

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

## Pipeline

1. **Authorize and normalize.** Remove inaccessible, malformed, quarantined, expired, retracted, and superseded candidates before ranking.
2. **Force governance.** Include applicable policies, hard constraints, output schema, current plan, unresolved obligations, and explicitly referenced records.
3. **Generate candidates.** Use source ports for exact references and lexical search now; semantic, graph, temporal, preference, and episode sources are declared but unavailable until later tasks.
4. **Resolve versions and conflicts.** Prefer active versions, preserve unresolved conflicts, and never silently merge contradictory values.
5. **Fuse and rerank.** Combine relevance, dependencies, authority, temporal validity, confidence, task fit, evidence, redundancy, cost, and security risk.
6. **Diversify and budget.** Select complementary records with reserved budgets for governance, task state, evidence, memory, examples, and output instructions.
7. **Order assembly.** Put durable constraints first, evidence near the subtask it supports, and immediate state and output schema near the end.
8. **Emit manifest.** Record selected and excluded IDs, reasons, scores, tokens, source versions, conflicts, order, failures, and compiler version.

## Required reason codes

Examples include `explicit_requirement`, `forced_governance`, `scope_denied`, `status_retracted`, `superseded_by_newer_record`, `outside_valid_time`, `task_relevance`, `entity_relation`, `high_authority`, `token_budget`, `redundant`, `security_risk`, and `candidate_source_failed`.

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

## Evaluation

Measure context precision, required-fact recall, distractor resistance, conflict handling, supersession accuracy, scope isolation, token efficiency, downstream task success, and stability across model changes. Never evaluate solely by filling a larger window.
