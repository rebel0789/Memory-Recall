# OAF-020 Pattern, Saturation, and Copying-Risk Note

OAF-020 adds deterministic Content Intelligence analysis after evidence normalization.

Implemented behavior:

- keeps raw metrics and caller-supplied baselines under `metrics`;
- keeps relative-performance state, pattern shape, cluster ID, lifecycle, proof-needed reasons, uncertainty, similarity, and copying risk under `inference`;
- classifies relative performance only when baselines exist;
- reports `creator_or_format_baseline` and high uncertainty when raw metrics are not comparable;
- clusters related mechanisms without storing raw source text in cluster records;
- flags high copying risk for near-duplicate wording and exposes rewrite-oriented reason codes;
- adds an `analyze-patterns` workflow step before context compilation;
- emits safe analysis context records that summarize states without embedding raw metrics as inference;
- adds `content-pattern-analysis` protocol schema and compatibility fixture.

Boundaries:

- no learned ranking, hosted analytics, external telemetry, embeddings, vector database, graph database, browser automation, publishing, external write, or external adapter was added;
- similarity is a deterministic lexical safeguard, not legal review or plagiarism certification;
- OAF-021 approval, local drafting, and outcome recording were not started.

Verification:

- `node --test tests/content-intelligence.test.mjs tests/workflow.test.mjs`
- `npm run protocol:validate`
- `npm run eval`
