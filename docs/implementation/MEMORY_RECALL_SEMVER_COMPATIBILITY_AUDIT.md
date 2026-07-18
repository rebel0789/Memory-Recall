# Memory Recall semantic-version compatibility audit

Audit date: 2026-07-18

Published baseline: `memory-recall@1.1.0` at commit `06a947fb52b5c23544a6e1b18ed8e28bd0735fb2`

Audited worktree: `codex/memory-recall-orientation-workbench` at commit `2273cdc3c7b821de261d5c4d778032515a114e36`

## Decision

The current worktree requires a **major stable line**. A patch release is
rejected. A minor release is supportable only if every breaking boundary below
is restored or dual-served and covered by compatibility tests.

This audit does not choose a version number. Version selection remains blocked
until implementation is frozen and the final compatibility and release gates
pass.

The size of the change is supporting context, not the reason for the decision:
`main...2273cdc` changes 351 files with 94,956 additions and 2,597 deletions. The
major-line conclusion comes from observed public contract breaks.

Commits through `2273cdc` add pagination, bounded exact-repository intelligence
gates, explicit Tier 1 applicability, qualifying import evidence for all
fourteen Tier 1 languages, qualifying Go, Rust, and Dart export evidence,
qualifying Dart call evidence, and a
fail-closed root publisher that requires and re-verifies the exact five native
registry artifacts. They do not restore or dual-serve any breaking boundary
recorded below, so the SemVer conclusion is unchanged.

## Evidence snapshot

The public package was inspected directly:

```bash
npm view memory-recall@1.1.0 name version dist.integrity dist.shasum dist.tarball --json
npm pack memory-recall@1.1.0 --pack-destination <temporary-directory> --json
```

The registry and packed artifact agreed on:

| Field | Published value |
| --- | --- |
| Package | `memory-recall@1.1.0` |
| Tarball | `https://registry.npmjs.org/memory-recall/-/memory-recall-1.1.0.tgz` |
| Integrity | `sha512-jBrawYpI+wluYrTwSRSPiwa4m+Cm+JQS4pkpSIbsH1ALC5POd2X5RqfBPhSMd6+zi60iGImq72AMP1Ftx0/vzA==` |
| SHA-1 | `e343012deaa10520ce2064eea0554c4a0f8b55a6` |
| Packed size | 1,209,674 bytes |
| Unpacked size | 5,215,304 bytes |
| Entries | 828 |

The published tarball contains `rust/Cargo.toml`, the `rust/oaf-*` sources,
`apps/cli/oaf.mjs`, and `docs/usage/rust-acceleration.md`. A current
`npm pack . --dry-run --json --ignore-scripts` check reported no `rust/` or
`native-packages/` entries in the root package. It did include the native binary
resolver. This proves the distribution-contract comparison without relying on
the source tree alone.

## Compatibility findings

| Public boundary | `1.1.0` contract | Current behavior | Result | Authoritative evidence |
| --- | --- | --- | --- | --- |
| Root npm distribution and Rust build path | The published package says Rust acceleration is opt-in, includes Rust source, and gives an exact local Cargo build path. | The root package excludes Rust source and resolves a binary through five platform-specific optional packages. | **Breaking**. Existing consumers lose the shipped, documented source-build contract and move to a different artifact topology. | Baseline `06a947fb52b5:docs/usage/rust-acceleration.md:3-11,29-46`; current `docs/usage/rust-acceleration.md:34-51`; `package.json:121,148-160`; registry and tarball inspection above. |
| Installed MCP configuration | `1.1.0` writes `mcp server --read-only --root ... --sqlite ... --stats ... --stdio`. | The owned signature now requires `--engine auto`. The old exact entry is classified as drifted; install refuses to upgrade it and uninstall refuses to remove it. | **Breaking**. A configuration written by the published release cannot follow the current managed upgrade or uninstall path. | Baseline `06a947fb52b5:apps/cli/oaf.mjs:7537-7561`; current `apps/cli/oaf.mjs:8786-8787,8836-8842,8901-8925,8987-8997,9016-9020`; `tests/cli.test.mjs:1769-1807,1877-1894,1915-1937`. |
| Recall Map wire format | The strict `1.0.0` schema and `memory-recall-map-1.1.0` report ID reject unknown architecture properties. | The same schema and report identifiers remain, but reports always emit `snapshot`, `groups`, `groupRelations`, and `processes`; the current schema was expanded in place. | **Breaking**. A strict consumer using the published schema rejects current output even though the version identifiers did not change. | Baseline `06a947fb52b5:packages/protocol/schemas/recall-map.schema.json:3,7-11,137-147`; current `packages/protocol/schemas/recall-map.schema.json:3,10-11,221-230`; `packages/recall-map/src/index.mjs:292-305,326-337`. |
| Default graph and MCP engine | The published public path defaults to the bounded JS/TS graph; Rust is explicit and locally built. | Graph and MCP reads default to `auto` and may return native SQLite-backed results when a current index is present. | **Breaking semantic default**. Identical commands can select a different engine and output based on local index state. | Baseline `06a947fb52b5:docs/usage/rust-acceleration.md:3-12`; current `docs/usage/rust-acceleration.md:3-12`; `apps/cli/oaf.mjs:3558-3560,6745-6747,7360-7467`; `tests/cli-graph-index.test.mjs:53-67`; `tests/mcp-code-intelligence.test.mjs:297-432`. |
| Shipped Rust source API and workspace | The published tarball exposes buildable Rust sources with `IngestOptions` and `IngestReport` shapes and workspace version `0.1.0`. | Public structs gain required fields such as `prefer_cpp_headers`, `recovered_files`, and `code_facts`; the workspace adds `oaf-index` and reports version `1.1.1`. | **Breaking source contract**. Existing Rust construction or deserialization against the shipped source may fail, and the workspace version change does not preserve the prior crate-level contract. | Baseline `06a947fb52b5:rust/oaf-ingest/src/lib.rs:20-38,60-78`; `06a947fb52b5:rust/Cargo.toml:1-8`; current `rust/oaf-ingest/src/lib.rs:20-40,239-260`; `rust/Cargo.toml:1-8`. |

## Additive work

The worktree also adds compatible capabilities:

- the read-only MCP inventory expands from five tools to twelve;
- graph index and repository commands are added;
- managed MCP uninstall is added;
- isolated persistent SQLite source indexes are added;
- five native platform packages are defined for macOS, Linux, and Windows.

These additions do not neutralize the breaks above. SemVer classification uses
the least-compatible public change in the release.

Current evidence for the additive MCP surface is
`tests/mcp-code-intelligence.test.mjs:7-23,48-99`. The published five-tool
inventory is fixed by
`06a947fb52b5:tests/cli.test.mjs:1694-1710,2033`.

## Repairs required before a minor line is defensible

A minor line is possible only if all of these conditions are met:

1. **Migrate legacy MCP entries.** Recognize the exact `1.1.0` server argument
   signature as Memory Recall-owned. Install must offer a safe, confirmed
   migration to the current signature, and uninstall must remove either owned
   generation without touching neighboring configuration.
2. **Version or dual-serve wire output.** Keep a strict `1.1.0` Recall Map mode
   that validates against the published schema, or introduce a new versioned
   schema/report contract and negotiate it explicitly. Do not emit new fields
   under the old identifiers to strict clients.
3. **Preserve or formally replace the Rust-source contract.** Continue shipping
   the documented buildable source surface with compatible public structs, or
   provide an explicit compatibility artifact and migration that preserves the
   published local-build use case.
4. **Preserve or negotiate the engine default.** Keep JS as the behavior for
   unversioned legacy invocations, or require an explicit/versioned negotiation
   before `auto` can change the engine and output semantics.
5. **Bind each repair to the published artifact.** Add focused tests using the
   exact `memory-recall@1.1.0` configuration, strict schema, command defaults,
   and Rust source surface. The tests must prove upgrade, operation, uninstall,
   and rollback against the packed current product.

If any condition remains unresolved at release freeze, the stable release must
remain on a major line. Adding release notes or documenting the break does not
make a patch or minor release backward compatible.

## Release stop condition

Do not choose or write a package version from this audit alone. Re-run the audit
against the frozen release commit and exact root tarball. The version decision
can proceed only when every row is either:

- backward compatible and proven against `memory-recall@1.1.0`; or
- intentionally breaking and assigned to a major stable line.
