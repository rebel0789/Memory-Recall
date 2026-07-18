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
`recall map` is the explicit read-only first scan: it combines bounded source
metadata with governed local-memory status. Structural graph, MCP, API, and web
reads use the packaged Rust index. `recall handoff` produces a read-only handoff
for the next coding-agent session.

## Support contract

- Implemented: native-default, freshness-gated graph reads, reviewed SQLite
  memory, and twelve read-only MCP tools. Missing or stale native state fails
  closed with the exact recovery action; JS/TS requires explicit compatibility
  mode.
- Implemented: bounded semantic plan and task packets, strict result import, pending proposals, and source-rechecked named approval.
- Experimental: the verified packaged Rust path has compiler-free local evidence across 14 Tier 1 fixtures, while full language and cross-platform release gates remain open. The bounded cross-repository path currently covers exact Go module resolution, one entry-to-service trace, and reverse impact across two explicitly registered repositories through the existing MCP tools.
- Experimental: explicit one-shot Gemini and OpenAI-compatible semantic API execution.
- Unsupported: automatic transcript capture, write-capable MCP, hosted sync,
  general cross-repository analysis beyond the measured exact Go path, and
  unmeasured Tier 1 capability rows.
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
