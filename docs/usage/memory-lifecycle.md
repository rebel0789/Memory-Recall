# Memory Lifecycle

Memory Recall treats memory as reviewed local state, not an automatic transcript dump.

## Lifecycle

| State | Meaning |
| --- | --- |
| `PENDING` | Candidate fact proposed from local sources. Not trusted yet. |
| `ACTIVE` | Reviewed fact available to handoff and MCP recall. |
| `REJECTED` | Candidate was reviewed and denied. |
| `SUPERSEDED` | Older active fact was replaced without hard delete. |
| `QUARANTINED` | Candidate looked unsafe, oversized, secret-like, or malformed. |

## Ingest

```bash
recall memory ingest --root . --sqlite .local/memory.sqlite --format json
```

Ingest reads local project evidence and creates proposals. It does not create
active memory.

## Review

```bash
recall memory review --root . --sqlite .local/memory.sqlite --format summary
```

Approve narrowly when possible:

```bash
recall memory approve --all-from workspace://PROJECT_STATUS.json --root . --sqlite .local/memory.sqlite --format json
```

Reject noise:

```bash
recall memory reject <proposal-id> --root . --sqlite .local/memory.sqlite --format json
```

## Refine

```bash
recall memory refine --read-only --root . --sqlite .local/memory.sqlite --format summary
recall memory refine --read-only --root . --sqlite .local/memory.sqlite --target-active-facts 200 --format json
```

Refine reports duplicate, stale, conflicting, and lineage-residue candidates. It
is a review tool; it does not silently rewrite trusted memory.

## Recall

```bash
recall mcp server --read-only --root . --sqlite .local/memory.sqlite --stdio
```

Agents receive reviewed active facts through `memory.recall` and compact context
through `context.profile` or `context.pack`.

