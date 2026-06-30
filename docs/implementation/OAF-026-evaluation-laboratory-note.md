# OAF-026 Evaluation Laboratory Note

OAF-026 adds a local, dependency-free evaluation laboratory for versioned
datasets, experiments, reports, and sanitized trace promotion.

Implemented behavior:

- `packages/evaluation-lab` creates deterministic-regression and
  model-quality-shadow datasets with stable fingerprints.
- Experiments bind a dataset, subject, baseline, candidate, mode, and
  fingerprint.
- Reports record runner, commit, compiler, prompt, model, policy, results,
  counts, and gate decision.
- Deterministic reports are merge-gated; model-quality reports are shadow-only
  and non-blocking by default.
- Failed traces can become regression cases only after classification review.
  Promotion stores original trace fingerprints, sanitized trace fingerprints,
  safe attributes, and provenance.

Security boundaries:

- No hosted judges, cloud APIs, external adapters, external writes, publishing,
  browser automation, model downloads, vector databases, graph databases, or
  embeddings were added.
- Trace promotion drops raw prompts, context bodies, outputs, credentials,
  provider URLs, local paths, hidden reasoning, SQL, cookies, tokens,
  authorization material, and private source bodies.
- `npm run eval` remains deterministic and offline.

Verification:

- Focused coverage: `tests/evaluation-lab.test.mjs`
- Protocol coverage: evaluation dataset, experiment, report, and trace-promotion
  schemas plus valid fixtures and one invalid raw-prompt fixture.
- Deterministic eval coverage: evaluation-lab assertions in `scripts/run-evals.mjs`
