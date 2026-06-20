# OAF-016 Evidence Citation Graph Note

## Intent

OAF-016 upgrades `packages/evidence` from observation helpers into a native reference evidence service. The service will keep source snapshots, observations, claims, and inference edges distinct so downstream workflows can cite evidence without treating interpretations as observed fact.

## Trust Boundaries

- Source snapshots and observations remain untrusted external data unless a later policy layer says otherwise.
- External adapters stay disabled; this task only normalizes caller-supplied records.
- No external writes, network calls, graph databases, vector databases, hosted models, or publishing are introduced.
- Evidence graph records are deterministic JSON objects with hashes and timestamps supplied by the caller for testability.

## Implementation Plan

1. Add tests that specify immutable snapshot normalization, observation/source linkage, deduplication, citation edges, staleness, and conflict behavior.
2. Implement pure functions in `packages/evidence/src/index.mjs`.
3. Add protocol schema/example coverage for the evidence graph result.
4. Update product and architecture docs plus project status only after gates pass.

## Verification

- `npm run ci`: passed.
- `npm run protocol:validate`: 91 passed, 0 failed.
- `npm test`: 154 passed, 0 failed.
- `npm run eval`: 88 passed, 0 failed.
