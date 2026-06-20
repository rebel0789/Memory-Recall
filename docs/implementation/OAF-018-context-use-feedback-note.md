# OAF-018 Context-Use Feedback Note

## Intent

OAF-018 adds deterministic feedback records for selected context use and task outcomes without claiming causality. It also adds reversible selector experiments and a review-only default-promotion plan that requires evaluation evidence.

## Trust Boundaries

- Feedback records reference persisted context manifests by ID and fingerprint.
- Feedback records store selected record IDs, use states, evidence references, and outcome references only.
- Raw prompts, outputs, context bodies, credentials, provider URLs, local paths, hidden reasoning, and private user data are not accepted.
- Outcome summaries use `causalClaim: none`.
- Selector experiments are reversible to the baseline policy fingerprint.
- Selector default promotion is a plan requiring human review, not a mutation.

## Implementation Summary

Added context-use feedback helpers, feedback summaries, selector experiment creation/resolution, and default-promotion validation in `packages/context-compiler/src/index.mjs`. Added protocol schemas and fixtures for feedback and selector-experiment records, focused tests in `tests/context-feedback.test.mjs`, and deterministic eval checks in `scripts/run-evals.mjs`.

OAF-018 does not enable hosted analytics, online experimentation, telemetry upload, hosted model providers, external adapters, external writes, publishing, embeddings, vector databases, graph databases, or browser automation.
