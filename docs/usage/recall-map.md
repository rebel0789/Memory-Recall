# Recall Map

`recall map` is the first explicit read-only command for understanding a local
repository. The command uses the bounded JavaScript/TypeScript compatibility
graph. The local web workbench prefers a healthy current Rust index and uses
the compatibility graph only when that index is unavailable. Both paths keep
source metadata separate from the governed local SQLite memory store.

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

Recall Map implements static source coverage for `.js`, `.jsx`, `.mjs`, `.cjs`,
`.ts`, and `.tsx` files. It does not claim a language server, a semantic graph
database, or support for every language. The report makes incomplete source
coverage explicit.

Discovery analyzes at most 1,000 supported files. Unsupported files, ignored
files, and excluded directories do not consume that budget. It honors root and
descendant `.gitignore` files plus a root `.recallignore`. Default exclusions
include source-control metadata, worktrees, dependency folders, virtual
environments, caches, test results, coverage output, and common build or
generated-output directories.

Coverage is reported as `complete`, `partial`, `stale`, or `unavailable`.
Partial reports include reason codes when file, node, or edge limits omit
candidates. A stale report contains the last valid graph after a refresh fails;
it is not presented as current or empty.

The local Control API reads a healthy current Rust index for Recall Map and
source preview requests without changing its SQLite bytes or timestamps. If no
current index exists, it reuses one bounded in-process JS/TS snapshot. A POST
request can set `refresh: true` to reload the map, but it never builds or
refreshes the Rust index. Index writes remain explicit CLI operations. GET is
cache-aware and read-only.

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

## Large repository check

Run the generated large-repository fixture with:

```bash
npm run source-graph:large-smoke
```

To measure an existing repository without editing it:

```bash
MEMORY_RECALL_LARGE_REPO_ROOT=/absolute/path/to/repository \
  npm run source-graph:large-smoke
```

The generated-fixture command verifies graph bounds, protocol validity,
in-process cache reuse, persistent-index reload, one-file incremental refresh,
and local safeguards. Its timings are measurements from the current machine,
not universal performance claims. A configured external repository remains
read-only, so that mode does not create a persistent index.

## Continue from the map

After reviewing the map, create a focused handoff for the next coding-agent
session:

```bash
recall handoff
```

For the compatibility alias and unchanged resource identifiers, see
[OAF compatibility](oaf-compatibility.md).
