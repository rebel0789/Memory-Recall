# Troubleshooting

## npm README Images Are Broken

The npm README loads badges and images from GitHub. If the GitHub repository is
private, npm cannot load those assets. Make the repository public before a public
launch, or replace GitHub-hosted README images with public asset URLs.

## `recall` Command Not Found

```bash
npm install -g memory-recall
npm bin -g
```

Make sure the global npm bin directory is on `PATH`.

## Node Version Fails

Memory Recall requires Node.js 22 or newer.

```bash
node --version
```

## MCP Server Does Not Connect

Preview the exact server command:

```bash
recall mcp install --client claude-code --dry-run --format json
recall mcp inspect --read-only --root . --format summary
```

Then run the printed server command directly. Most failures are path, Node
version, or missing global install issues.

## MCP Tools Are Missing

`recall mcp install` and `recall connect` install different MCP paths. The
confirmed `mcp install` path exposes twelve read-only tools, including `repo.map`
and `code.impact`. The Codex/Claude Code `connect` path installs a resource
bridge and hooks; its MCP `tools/list` is intentionally empty.

```bash
recall mcp inspect --read-only --root . --format summary
recall mcp install --client codex --dry-run --format json
recall connect codex --dry-run --format json
```

Choose the path you need instead of applying both by assumption. See the
[support matrix](support-matrix.md) for configuration and hook boundaries.

## Memory Recall Returns No Facts

Ingest creates proposals, not active facts.

```bash
recall memory ingest --root . --sqlite .local/memory.sqlite --format json
recall memory review --root . --sqlite .local/memory.sqlite --format summary
recall memory approve --all-from workspace://PROJECT_STATUS.json --root . --sqlite .local/memory.sqlite --format json
```

Approve only facts you want future agents to receive.

## The npm Page Shows Old Text

npm versions are immutable. If `1.0.0` has stale README text, publish a patch
version and point users at the latest version.

```bash
npm view memory-recall versions --json
npm install -g memory-recall@latest
```

## More

See the repository-level [Troubleshooting](../../TROUBLESHOOTING.md) guide for
local development, bootstrap, and CI issues. For measurement wording and
reproduction, see [Benchmark proof](../benchmarks.md). For removal without data
loss, see [Uninstall and data preservation](uninstall.md).
