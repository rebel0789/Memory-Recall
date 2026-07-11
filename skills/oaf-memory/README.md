# Memory Recall Semantic Setup

`skill:oaf-memory` is the preserved compatibility ID for the governed semantic
setup procedure. Existing `/oaf-memory` and OAF-named triggers still select it.

The default harness flow is:

```bash
recall semantic plan --harness codex --root . --dry-run
recall semantic task --harness codex --root .
recall semantic import --input semantic-result.json --root . --sqlite .local/memory.sqlite
recall memory review --root . --sqlite .local/memory.sqlite --format summary
recall memory approve <mpq_id> --root . --sqlite .local/memory.sqlite --format json
```

The plan is local and body-free. The task prints the bounded source packet; the
currently active agent executes it and saves strict result JSON. The CLI does
not invoke a harness. Import creates pending proposals only, bulk approval skips
them, and named approval rehashes every cited source.

See [Semantic setup](../../docs/usage/semantic-setup.md) for the direct API path,
packet limits, result schema, review flow, and failure handling.
