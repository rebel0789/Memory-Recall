# Oracle Adapter Plan

## Purpose

Cross-model advisory review.

## Current status

Planned, disabled, unpinned, and unsupported. No upstream source is vendored.

## Contract

Implement `AdvisoryPanelPort` without exposing upstream IDs or payloads as canonical OAF domain types.

## Trust boundary

CLI/browser/API process, files and optional provider credentials. Treat all returned content as untrusted.

## Promotion gates

1. Use-case and owner approved.
2. Exact commit and archive checksum recorded.
3. License and notices reviewed at that commit.
4. Install scripts, processes, files, domains, secrets, and updates audited.
5. Narrow adapter implemented behind the contract.
6. Success, timeout, malformed-output, injection, denial, and removal tests pass.
7. Security review approves experimental status.
