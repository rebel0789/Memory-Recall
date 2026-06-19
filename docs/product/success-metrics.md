# Success Metrics

## North-star outcome

**Verified useful tasks completed per unit of human attention.** “Useful” requires task-specific acceptance, not merely model completion.

## Platform metrics

- task success rate after deterministic validation;
- human interventions per successful task;
- recovery rate after process or tool failure;
- unintended side effects;
- time to diagnose a failed run;
- portable export and restore success;
- adapter conformance pass rate.

## Context metrics

- precision at a fixed token budget;
- required-fact recall;
- distractor inclusion rate;
- supersession and conflict accuracy;
- cross-workspace leakage rate, target zero;
- context tokens per successful task;
- downstream performance against a fixed full-context baseline.

## Content metrics

- candidate approval rate;
- user edit distance;
- unsupported-claim rate;
- source citation validity;
- copying-risk failures;
- creator-selected outcome such as qualified replies, saves, leads, or product feedback.

## Guardrails

Do not optimize solely for tokens, speed, engagement, or model agreement. A cheaper wrong action and a popular copied post are failures.
