# Quality Gates

## Every pull request

- repository checks;
- unit and contract tests;
- relevant deterministic evaluations;
- documentation and status consistency;
- no secret patterns;
- no enabled unpinned adapter;
- no runtime dependency without accepted ADR.

## Security-sensitive pull request

Add threat-model update, adversarial tests, permission diff, data classification, secret/egress review, and security reviewer.

## UI pull request

Add screenshots or recorded states, accessibility checklist, keyboard path, responsive widths, dark/light, reduced motion, and stable URL evidence.

## Release

Clean checkout, reproducible build, full tests/evals, migration rehearsal, backup/restore, SBOM, provenance, image digests, license notices, vulnerability scan, signed tag/artifacts, rollback, and support readiness.
