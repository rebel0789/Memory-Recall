# Agent Flight Recorder and Safe Learning

## Flight record

A replayable run includes:

- workflow and Agent Pack fingerprints;
- prompt, skill, policy, model, and compiler versions;
- selected and excluded context with reason codes;
- tool requests, decisions, inputs, outputs, and idempotency keys;
- memory proposals and lifecycle changes;
- approvals and expirations;
- artifacts and source hashes;
- validation and evaluation results;
- timing, retries, cancellation, and resource usage.

## Replay modes

- `exact`: same recorded inputs and versions, no external writes;
- `alternate-model`: same evidence package, different model role binding;
- `alternate-context`: same task and model, different compiler policy;
- `fork-from-step`: new run derived from one completed step;
- `shadow`: candidate implementation receives recorded events but cannot perform side effects.

## Learning proposal

A learning proposal must include observed failure, evidence IDs, proposed change, expected benefit, affected components, regression tests, rollout, and rollback. It is evaluated in shadow mode before activation.

Engagement or model agreement alone is not proof of improvement. Promotion requires the workflow-specific acceptance suite.
