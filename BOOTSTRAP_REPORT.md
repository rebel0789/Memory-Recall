# Bootstrap and Handoff Verification Report

## Purpose

This report records the packager's reproducibility check for Open Agent Fabric 0.2.0-dev. Foundation task OAF-001 is complete. The machine-readable run is `HANDOFF_VERIFICATION.json`; file integrity is recorded in `REPOSITORY_MANIFEST.json`.

## Verification snapshot

- Date: June 19, 2026
- Platform used by packager: Linux x64 container
- Node.js: 22.16.0
- npm: 10.9.2
- Runtime npm dependencies: 0
- Default model: deterministic local bootstrap
- Default network policy: denied
- External writes: disabled
- External adapters: disabled
- Native SQLite: available with FTS5; Node 22 API is experimental

## Commands

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run bootstrap
npm run doctor
npm run verify:handoff
```

`verify:handoff` executes:

```bash
npm run check
npm test
npm run eval
npm run demo
npm run native:smoke
npm run manifest
```

## Verified evidence

- 56 Node tests passed; 0 failed.
- 12 protocol valid, invalid, and backward-compatibility fixtures passed.
- 22 deterministic evaluation assertions passed; 0 failed.
- 5 native provider manifests and 12 external adapter contract fixtures passed repository checks.
- Native SQLite memory, content-addressed artifacts, Agent Pack fingerprinting, and deterministic model smoke passed without network access.
- The Content Intelligence demo completed with three cited recommendations.
- The unrelated high-engagement recipe fixture was excluded as `candidate_ineligible`.
- No API key, model download, database server, cloud account, or external write was required.

## Demonstrated vertical slice

```text
synthetic observations
→ separate observation from inference
→ assess eligibility and anti-patterns
→ compile a governed context budget
→ generate three deterministic candidates
→ verify every evidence ID
→ expose run, events, selected context, and exclusions
```

## Native reliability baseline

```text
SQLite + FTS5 workspace memory
content-addressed filesystem artifacts
cancellable embedded workflows with event checkpoints
deterministic local model fixture
optional explicit loopback Ollama provider
portable Agent Packs
safe replay plans and learning proposals
```

## Explicit limitations

This verification does not certify production authentication, PostgreSQL runtime persistence, process-crash workflow recovery, hardened sandboxing, real connectors, real social data, external publishing, signed Agent Pack distribution, telemetry, backup/restore, or multi-user deployment. Those remain explicit tasks in `planning/backlog.json`.

## OAF-001 through OAF-003 completion

```text
OAF-001: clean bootstrap, doctor, CI, demo, native smoke, and reproducible handoff evidence complete.
OAF-002: provider-neutral schemas, dependency-free validation, and compatibility fixtures complete.
OAF-003: application ports, provider envelopes, conformance helpers, and adapter expectation fixtures complete.
Safest next task: OAF-004 — PostgreSQL repositories behind existing ports.
```
