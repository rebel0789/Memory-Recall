# Evaluation Strategy

## Layers

1. **Contract tests:** schemas, ports, event envelopes, permissions, timeouts, idempotency.
2. **Deterministic behavior tests:** selectors, memory gates, workflow transitions, citation validation.
3. **Adversarial tests:** injection, leakage, stale/superseded records, conflicting facts, repeated side effects.
4. **Model quality evaluations:** structured output, evidence use, copying risk, calibration, task utility.
5. **System evaluations:** full workflow success, recovery, human intervention, latency, resources.

## Reproducibility

Every evaluation records dataset version, code commit, compiler/prompt/model versions, seed or temperature, local hardware where relevant, token budget, policy version, and scoring implementation.

## Context Compiler baseline

Compare against fixed recent-history, vector top-k, full-available-context, and exact-reference baselines. Hold task, model, and output scoring constant. Measure precision, required recall, distractor rate, conflict/supersession correctness, scope leakage, tokens, and downstream success.

OAF-010 adds deterministic candidate-generation checks before selection:
exact-ID recall, lexical candidate discovery, source provenance, query
fingerprints, contextual-policy denial before provider invocation, candidate
data-class filtering, source report status, optional-source warning behavior,
required-source failure behavior, cancellation/timeout handling, and
same-identity union conflict handling. These checks do not score hybrid fusion,
reserved token budgets, or diversity selection.

OAF-011 adds deterministic selection evaluations for required-record recall,
required-entity coverage, distractor exclusion, duplicate suppression,
complementary evidence, precision under order changes, smallest-sufficient
stopping, conflict preservation, supersession, workspace and data-class
filtering, and optional source-failure propagation from native candidate
sources. The eval runner also asserts safe internal trace fields including
policy fingerprint, result fingerprint, selected/excluded score states, and
coverage summaries.

OAF-012 adds deterministic persisted-manifest checks for assembly order,
manifest fingerprint verification, comparison output, required-governance
overflow, persistence, zero excluded-text leakage, workspace isolation, and
retry idempotency.

OAF-018 adds deterministic context-feedback checks for selected-record use
against a manifest, unselected-record rejection, non-causal feedback summaries,
reversible selector experiments, default-promotion evaluation requirements, and
review-only promotion plans.

OAF-014 adds deterministic durable-workflow checks for process recovery, retry
recovery, timer recovery, approval-wait recovery, cancellation persistence,
no completed-step repetition, idempotent effect count of one, monotonic event
history, workspace isolation, version-fingerprint conflicts, and zero
secret/path leakage.

## Model-backed changes

Separate nondeterministic quality tests from merge-blocking contract tests. A model default may change only after a versioned evaluation report and rollback plan.

## Production-to-regression loop

A failed trace may become a fixture only after sanitization, classification review, minimal reproduction, and explicit provenance. Do not copy private user data into the public suite.

## OAF-026 Evaluation Lab

Evaluation records now use four protocol shapes:

- evaluation datasets: versioned case collections with a suite type and
  fingerprint;
- evaluation experiments: dataset, subject, baseline, candidate, mode, and
  fingerprint;
- evaluation reports: runner, commit, compiler, prompt, model, policy, counts,
  results, and gate decision;
- trace promotions: reviewed, sanitized run fragments promoted into regression
  cases.

`deterministic-regression` datasets are merge gates. `model-quality-shadow`
datasets are explicit non-blocking suites for local model/prompt comparisons.
Shadow failures are recorded as `shadow_failed_non_blocking`; they do not change
defaults or fail CI by themselves.

Trace promotion stores original and sanitized fingerprints plus safe attributes
only. Raw prompts, context bodies, outputs, credentials, provider URLs, local
paths, hidden reasoning, SQL, cookies, tokens, authorization material, and
private source bodies remain out of fixtures and reports.
