# Evaluation Lab

OAF-026 records versioned evaluation artifacts for local regression work.

Deterministic datasets are merge gates and run through `npm run eval`.
Model-quality datasets are shadow suites: they can compare prompts, local
models, and workflow outputs, but they do not block CI or change defaults until
a reviewed report and rollback plan approves the change.

Trace promotion is allowed only after classification review and sanitization.
Promoted cases store fingerprints, reason codes, and safe attributes, never raw
prompts, context bodies, outputs, credentials, local paths, provider URLs,
hidden reasoning, SQL, cookies, tokens, or private source bodies.
