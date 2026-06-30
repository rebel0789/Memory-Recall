# OAF-011 Context Selection Implementation Note

## Current Responsibilities

- `compileContext(request, records)` is the synchronous public API used by the Control API, CLI, workflow demo, eval runner, and existing tests.
- `generateContextCandidates(...)` is the OAF-010 asynchronous candidate-generation path. It validates source requests, invokes enabled candidate sources, validates source output, merges same-identity hits, and reports source failures.
- `compileContextFromSources(...)` currently calls `generateContextCandidates(...)`, strips candidates back to records, and delegates final selection to `compileContext`.
- Candidate eligibility currently lives inside `compileContext`: scope checks, lifecycle status checks, temporal validity, supersession, and ineligible retrieval flags.
- Required records currently receive forced score treatment but over-budget required records are excluded with a warning rather than fail-closed.
- Supersession currently excludes any record whose ID is referenced by another record's `supersedes`.
- Conflict detection currently groups eligible records by `metadata.conflictKey` and surfaces unresolved value disagreement.
- Task relevance currently uses deterministic lexical overlap over objective, step, required entities, record text, tags, and relations.
- Authority, confidence, importance, outcome evidence, retrieval penalty, recency, and kind overlap currently influence a single score.
- Token budgeting currently selects forced records first, then remaining scored records until the budget is exhausted; remaining tokens can still drive extra context.
- Diversity currently consists of a small same-kind score adjustment, not bounded redundancy detection or category budgeting.
- Selected/excluded decisions currently expose record ID, kind, token estimate, score, reason codes, source, and text in the context manifest.

## OAF-011 Direction

OAF-011 will keep the public `compileContext(request, records)` API synchronous and evolve the existing selector into one shared internal engine. Direct-record calls will wrap records as canonical candidates with synthetic direct-source diagnostics; source-based calls will pass OAF-010 canonical candidates with source hits. Both paths will use the same eligibility, fusion, reranking, diversity, budgeting, sufficiency, conflict, and decision code.

The selector will add a committed versioned selection policy with deterministic fingerprinting. Weighted reciprocal-rank fusion will use source-local rank only; provider scores remain diagnostics. Required records will remain hard requirements and fail closed when unresolved, denied, conflicted, or over budget. Optional selection will favor complementary evidence through bounded token-shingle similarity, category caps/reserves, and smallest-sufficient stopping. OAF-011 will keep detailed traces in memory and will not add manifest persistence, public tuning APIs, external adapters, model rerankers, vector stores, graph stores, outbound network access, or browser automation.
