# Recall Map

`recall map` is the first explicit read-only command for understanding a local
repository. It combines the implemented bounded JavaScript/TypeScript static
source graph with the status of the governed local SQLite memory store.

Run it from the repository you want to inspect:

```bash
recall setup
recall map --root . --sqlite .local/memory.sqlite --format summary
```

`recall setup` creates only local state. It does not scan the repository or run
Recall Map for you.

## Interface

```text
recall map [--root .] [--sqlite .local/memory.sqlite] [--changed-from-git]
           [--changed path/to/file] [--query text]
           [--format json|summary|markdown]
```

`--changed` is repeatable. Use it when you want to name reviewed
workspace-relative files explicitly:

```bash
recall map \
  --root . \
  --changed apps/web/app.js \
  --changed services/control-api/src/server.mjs \
  --query "authentication route" \
  --format json
```

Use `--changed-from-git` to detect changed files through local git only. If git
metadata is unavailable, Recall Map keeps any explicit `--changed` paths and
prints a diagnostic instead of invoking a network service.

## Formats

`--format summary` is the default. It prints source support and coverage, top
entry points, changed-file impact, separate active/pending memory counts, next
commands, and safeguards.

`--format json` returns the complete versioned Recall Map report as the exact
strict `RecallMapReport` schema object: it has no transport envelope or
`command` field. The report contains safe locators and summaries only; it does
not contain source or memory bodies.

`--format markdown` returns the same bounded facts in a copyable report with
Support, Architecture, Memory, Next commands, and Safeguards sections.

## What it reads and does not read

Recall Map implements static JavaScript and TypeScript source coverage. It does
not claim a language server, a semantic graph database, or support for every
language. The report makes incomplete source coverage explicit.

When `.local/memory.sqlite` is absent, the report remains read-only and reports
the memory store as missing. It never creates a database just to produce a map.
ACTIVE facts, PENDING proposals, and stale-fact counts remain separate.

Every format is local and read-only:

- no workspace files are written;
- no canonical memory state changes;
- no model or network calls;
- no external adapters enabled;
- no raw source or memory bodies; and
- no absolute local workspace paths in the report.

Recall Map exits `0` for a safe report and `2` for invalid command arguments.

## Continue from the map

After reviewing the map, create a focused handoff for the next coding-agent
session:

```bash
recall handoff
```

For the compatibility alias and unchanged resource identifiers, see
[OAF compatibility](oaf-compatibility.md).
