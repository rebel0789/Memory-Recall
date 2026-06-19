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

## Model-backed changes

Separate nondeterministic quality tests from merge-blocking contract tests. A model default may change only after a versioned evaluation report and rollback plan.

## Production-to-regression loop

A failed trace may become a fixture only after sanitization, classification review, minimal reproduction, and explicit provenance. Do not copy private user data into the public suite.
