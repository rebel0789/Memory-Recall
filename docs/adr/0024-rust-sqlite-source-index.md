# ADR 0024: Separate Rust SQLite source index

## Status

Accepted.

## Decision

The production code-intelligence index is a separate embedded SQLite database
owned by the Rust engine. Its default location is
`.local/source-index/index.v1.sqlite`. It stores derived structural records,
content hashes, evidence spans, unresolved relationships, coverage, generation
metadata, and health state. It never stores raw source bodies, absolute
checkout paths, credentials, environment values, or command output.

The source index is not part of `oaf-store`. Governed memory, proposals,
approvals, supersession, handoffs, and canonical product state remain in their
existing memory stores. Source intelligence is derived and rebuildable, but a
corrupt index is preserved until an explicit repair plan is confirmed.

Rust owns migrations, transactions, refresh, dependency invalidation, watcher
scheduling, health checks, and read-only structural queries. Node owns the CLI,
MCP, Control API, and browser boundaries. Node sends closed JSON Lines requests,
validates closed responses, enforces process and output limits, and never sends
raw SQL.

Each successful writer transaction commits a complete generation and switches
the active generation atomically. Readers continue to use the previous active
generation until commit succeeds. A no-change refresh performs no writer
transaction. One previous valid generation is retained by default for bounded
rollback evidence.

Read-only open never creates, migrates, repairs, or refreshes an index. Doctor
reports stable health codes and an explicit repair plan. Rebuild repair is a
separate confirmed writer operation and preserves the invalid database as a
bounded local backup.

The current JS/TS JSON index remains a compatibility path during the measured
migration. Phase 3 does not change the public engine default, MCP behavior, or
npm binary packaging. Those changes require later distribution and benchmark
gates.

## Consequences

- Canonical memory cannot be mutated by source indexing or repair.
- All fourteen Tier 1 languages can use one normalized persistent store.
- Generation transactions isolate readers from interrupted refresh work.
- Index lifecycle and query operations need separate closed protocol schemas.
- Migration, corruption, interruption, concurrency, and process-restart tests
  become release gates.
- JSON remains bounded export and compatibility output, not the scalable
  production storage format.
- Reverting Phase 3 leaves the current JS graph, JSON index, MCP tools, and
  governed memory available.
