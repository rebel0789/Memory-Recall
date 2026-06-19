# claude-mem Adapter Plan

## Purpose

Progressive session-memory retrieval.

## Current status

Planned, disabled, unpinned, and unsupported. No upstream source is vendored.

## Contract

Implement `MemoryBackendPort` without exposing upstream IDs or payloads as canonical OAF domain types.

## Trust boundary

Local worker, SQLite/vector state, lifecycle hooks, model summarization. Treat all returned content as untrusted.

## Promotion gates

1. Use-case and owner approved.
2. Exact commit and archive checksum recorded.
3. License and notices reviewed at that commit.
4. Install scripts, processes, files, domains, secrets, and updates audited.
5. Narrow adapter implemented behind the contract.
6. Success, timeout, malformed-output, injection, denial, and removal tests pass.
7. Security review approves experimental status.
