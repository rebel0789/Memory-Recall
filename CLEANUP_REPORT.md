# G0 Cleanup Report

Behavior-preserving de-bloat pass on `codex/native-cleanup` (based on
`codex/loop-workbench-super`). Goal: remove genuinely dead/redundant code without
changing any public behavior. CI must stay green.

## Headline finding

**This codebase is not bloated with dead code.** An automated audit of all 411
exported symbols across `packages/ apps/ services/ providers/ adapters/ workflows/
scripts/ tests/` found only ~30 with zero references — and almost all of those are
**intentional surface**, not waste:

- **Adapter contract ports** (`MemoryBackendPort`, `ToolExecutionPort`, …, `PORTS`)
  — the entire purpose of `packages/adapter-contracts`; "unused" only because
  adapters are disabled by design (ADR-0012). **Keep.**
- **Disabled team/cloud organ** (`PostgresIdentityRepository`,
  `createPostgresRepositories`, `MIGRATION_LEDGER_TABLE`) — planned Postgres
  adapter. **Keep.**
- **Public package API not yet consumed internally** (`loadAgentPack`,
  `writeAgentPack`, `authorizeWorkspaceAction`, `*_VERSION` constants,
  `EVENT_TYPES`, selection/exclusion reason-code enums) — published library
  surface. Deleting these because nothing calls them *yet* would break the
  contract/conformance story that is the project's core value. **Keep.**

The real over-engineering is **duplication and file size**, not dead code (see
"Real overwork" below).

## Safe removals applied in this pass

Only genuinely orphaned, non-API code (zero references including tests, not part
of any contract or public API), plus the imports they orphaned:

| Symbol | File | Why safe |
| --- | --- | --- |
| `removeOperationsBackupForTest` | `packages/operations/src/index.mjs` | Test-only helper, zero callers (not even tests). Dropped the now-unused `rm` import. |
| `reviewedProcedureIndexPath` | `adapters/tool/ecc/src/index.mjs` | Disabled-adapter internal, zero callers. Dropped the now-unused `fileURLToPath` import. |

Net: ~14 lines removed, no behavior change, CI green.

## Deliberately NOT removed (and why)

- **~49 "over-exported" symbols** (used internally, just needlessly `export`ed):
  un-exporting tightens API but is churn across 17 files with near-zero functional
  value and small risk. Left as-is; can be a later mechanical pass.
- **Test-file scaffolding consts** flagged as unused: removing a `const x = …`
  in a test can change behavior if the RHS has side effects. Tests are green;
  left untouched.
- **The 10 "orphan" scripts** in `scripts/` (e.g. `verify-handoff.mjs`,
  `validate-protocol.mjs`) are **not orphans** — they are `npm run` entry points
  invoked by `package.json`/CI. **Do not delete.**

## Real overwork (the actual cleanup targets — deliberate tasks, not auto-delete)

These are where the codebase genuinely "overworked," but reducing them safely
needs care, so they are flagged here rather than rushed:

### 1. Utility duplication (highest value)

The same small utilities are reimplemented in many packages:

| Helper | # of source copies |
| --- | --- |
| `sha256` | 9 |
| `stableStringify` | 6 |
| `deepFreeze`, `assertPlainObject`, `safeString` | 4 each |
| `canonicalStringify`, `withTimeout`, `boundedInteger`, `assertNoUnknown`, `normalizeDataClass` | 3 each |
| ~20 more (`deepClone`, `hash`, `byteLength`, `requireIso`, …) | 2 each |

**Why not fixed now:** several of these (`sha256`, `stableStringify`,
`canonicalStringify`) feed **fingerprint/ID determinism**. If the copies are not
byte-identical, consolidating them silently changes fingerprints and breaks
reproducibility + tests. Consolidation must (a) confirm each copy is semantically
identical, (b) respect package independence (a shared util module must not create
a forbidden cross-layer dependency), and (c) be guarded by fingerprint-equivalence
tests. **Recommended as a dedicated Codex task (G0.5).**

### 2. Structural size

- `packages/harness-context/src/index.mjs` — **4,721 lines** in one file.
- `apps/cli/oaf.mjs` — **2,323 lines**, with ~20 context-pack subcommand variants
  (scan / preview / pack / receive / handoff / measure / graph / mcp / registry /
  harness-setup …) and many near-duplicate `build*Report` helpers.

**Why not fixed now:** splitting the file is a refactor (risk of breakage) and
trimming CLI variants changes user-facing behavior + breaks tests/docs — a
**product decision**, not a behavior-preserving cleanup. Recommend deciding which
context-pack commands are load-bearing vs redundant, then removing/merging with
test+doc updates.

## Recommended follow-up Codex tasks

- **G0.5 — Consolidate duplicated utilities** into one shared internal module,
  byte-for-byte equivalent, verified by fingerprint-equivalence tests. Biggest
  real line reduction; must not change any fingerprint.
- **G0.6 — Split `harness-context/src/index.mjs`** into cohesive modules
  (context-pack, harness-scan, loop-*, registry) behind the same exports. Pure
  reorganization, no behavior change.
- **G0.7 — Rationalize CLI surface** (product decision): keep the load-bearing
  context/loop commands, merge/remove strict-subset variants, update tests + docs.

## CI

`npm run ci` after the safe removals: green (see commit).
