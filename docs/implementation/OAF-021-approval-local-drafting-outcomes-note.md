# OAF-021 Approval, Local Drafting, and Outcomes Note

OAF-021 adds a local-only creator completion record after recommendation citation verification.

Implemented behavior:

- preserves the exact editable candidate preview;
- binds approval to candidate ID/rank, evidence IDs, prompt version, output schema name/version, provider/model metadata, persisted context manifest reference, and a deterministic operation fingerprint;
- represents approved, rejected, expired, and cancelled approval states;
- creates local draft records only from approved candidates;
- revalidates evidence citations and rechecks edited-text similarity/copying risk after edits;
- records objective-specific outcome metrics, qualitative local review notes, and edit distance from approval preview to edited draft;
- adds a `local-draft-outcome` workflow step after recommendation verification;
- adds `content-local-draft-outcome` protocol schema and compatibility fixture coverage.

Boundaries:

- no publisher, external write, authenticated social connector, browser automation, hosted analytics, external adapter, embedding store, vector database, or graph database was enabled;
- Postiz remains planned, unpinned, disabled, and unsupported;
- workflow events summarize fingerprints, counts, validity, and publisher-disabled state instead of raw draft bodies or source text;
- outcome records use `causalClaim: none`.

Verification:

- `node --test tests/content-intelligence.test.mjs tests/workflow.test.mjs`
- `npm run protocol:validate`
- `npm run eval`
