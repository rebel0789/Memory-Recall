# OAF-027 Low-Risk Read-Only Adapter Note

OAF-027 promotes one adapter only: `adapter:tool:ecc`.

The selected use case is reviewed procedure proposals. ECC is pinned at commit
`34faa39bd3cd496a0aece0245f2b7e38b7923abc` with archive SHA-256
`c4a147dfb3766ee4eaedf74efbbc62cb5cdab014a5df98bee67020fb05871ae0`.
GitHub license metadata and the pinned archive `LICENSE` were reviewed as MIT
on 2026-06-20.

The adapter intentionally uses `installation.mode: none`. It does not install
ECC, execute package scripts, run hooks, invoke commands, call networked skills,
vendor upstream source, or bulk-load upstream procedure bodies. The adapter
reads only `reviewed-procedures.json`, returns safe summaries with provenance,
and creates proposal-only records after an exact `skills.importProposal` grant.

Conformance and adversarial coverage lives in `tests/ecc-adapter.test.mjs`.
The tests prove:

- `SkillSourcePort` shape and executable fixture pass;
- missing or mismatched grants deny invocation;
- malformed provider output and blocked raw fields fail closed;
- oversized output fails closed;
- timeout and cancellation reach the adapter boundary;
- proposal output preserves upstream commit, checksum, license, and source path
  without raw prompt, source body, secret, local path, token, or private body
  leakage;
- canonical state is not mutated directly;
- external adapters remain disabled by default, with exactly one experimental
  catalog entry.

OAF-027 does not enable publishing, external writes, browser automation, public
internet connectors, hosted services, model providers, vector databases, graph
databases, embeddings, or the rest of the adapter catalog.
