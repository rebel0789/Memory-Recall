# Memory Recall: Developer-First Product Contract

Memory Recall is the local-first, governed context layer for a developer's
repository. Normal user documentation uses the `recall` command.

## First win

Install Memory Recall once, then run these commands from the repository where
you want to work:

```bash
npm install -g memory-recall
recall setup
recall map --root . --sqlite .local/memory.sqlite --format summary
recall handoff
```

`recall setup` initializes local Recall state without scanning the repository.
`recall map` is the explicit read-only first scan: it combines the implemented
JS/TS static graph with governed local-memory status. `recall handoff` produces
a read-only handoff for the next coding-agent session.

## Support contract

- Implemented: local JS/TS static graph, optional persistent incremental index,
  reviewed SQLite memory, and twelve read-only MCP tools.
- Implemented: bounded semantic plan and task packets, strict result import, pending proposals, and source-rechecked named approval.
- Experimental: Rust acceleration paths require a local build before explicit invocation.
- Experimental: explicit one-shot Gemini and OpenAI-compatible semantic API execution.
- Unsupported: automatic transcript capture, write-capable MCP, hosted sync,
  non-JS/TS source graph analysis, cross-repository analysis, and million-node indexes.
- Unsupported: automatic harness invocation, arbitrary semantic providers,
  semantic retrieval, raw source-code upload, background semantic sync, and
  automatic semantic memory activation.

Semantic setup generates proposals from selected documentation and
configuration sources. It is separate from semantic retrieval and does not
change the default deterministic model or network-deny settings. See
[Semantic setup](../usage/semantic-setup.md) for the harness, direct API, review,
and source-change flow.

## Compatibility boundary

Public quickstarts use `recall`. Legacy OAF executable aliases, resource URIs,
and protocol identifiers remain supported and are documented in
[OAF compatibility](../usage/oaf-compatibility.md). They are not removed or
renamed by this product-copy migration.
