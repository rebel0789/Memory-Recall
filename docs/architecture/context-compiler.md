# Context Compiler

## Purpose

The Context Compiler answers one question for every model call:

> Of everything this workspace could know, what is the smallest sufficient set this step should reason over now?

It is not a vector-search wrapper. It is a deterministic, versioned selection pipeline.

## Request contract

A request includes workspace, actor, task, step, objective, required IDs and entities, token budget, allowed scopes or data classes, time, and a task profile.

## Pipeline

1. **Authorize and normalize.** Remove inaccessible, malformed, quarantined, expired, retracted, and superseded candidates before ranking.
2. **Force governance.** Include applicable policies, hard constraints, output schema, current plan, unresolved obligations, and explicitly referenced records.
3. **Generate candidates.** Use exact references, lexical search, semantic search, graph edges, temporal queries, preferences, and successful episodes.
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
- requested data class is prohibited;
- assembly cannot be reproduced.

## Evaluation

Measure context precision, required-fact recall, distractor resistance, conflict handling, supersession accuracy, scope isolation, token efficiency, downstream task success, and stability across model changes. Never evaluate solely by filling a larger window.
