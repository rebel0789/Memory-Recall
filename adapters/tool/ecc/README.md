# ECC Adapter

## Purpose

Source of individually reviewed procedures.

## Current status

Experimental, disabled by default, pinned, license-reviewed, and no-install. No upstream source is vendored, installed, executed, or bulk-loaded.

Reviewed upstream metadata:

- Repository: `https://github.com/affaan-m/ECC`
- Commit: `34faa39bd3cd496a0aece0245f2b7e38b7923abc`
- Archive SHA-256: `c4a147dfb3766ee4eaedf74efbbc62cb5cdab014a5df98bee67020fb05871ae0`
- License: `MIT`

## Contract

Implement `SkillSourcePort` without exposing upstream IDs or payloads as canonical OAF domain types.

## Trust boundary

Never bulk-load; copy only reviewed minimal procedures with provenance. Treat all returned content as untrusted.

The OAF adapter reads only `reviewed-procedures.json`, emits proposal-only records, and requires an exact grant for `skills.importProposal`. It does not run ECC installers, package scripts, hooks, commands, networked skills, or update logic.

## Promotion gates

1. Use-case and owner approved: done for reviewed procedure proposals.
2. Exact commit and archive checksum recorded: done in `UPSTREAM.lock`.
3. License and notices reviewed at that commit: MIT reviewed on 2026-06-20.
4. Install scripts, processes, files, domains, secrets, and updates audited: no-install boundary chosen; upstream installers and package scripts are not executed.
5. Narrow adapter implemented behind the contract: `src/index.mjs`.
6. Success, timeout, malformed-output, oversized-output, cancellation, denial, and non-mutation tests pass: `tests/ecc-adapter.test.mjs`.
7. Security review approves experimental status: recorded in `adapter.json`.
