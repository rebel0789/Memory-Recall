# Troubleshooting

## Node is too old

Run `node --version`. The bootstrap requires Node.js 22 or newer.

## Port 4310 is busy

```bash
OAF_PORT=4311 npm run dev
```

## State is invalid

The bootstrap file is `.local/state.json`. Browser users should sign in to the
local owner account and use **Reset demo**. The `/api/reset` route is protected
by the browser session and CSRF checks, so unauthenticated `curl` requests are
expected to fail.

For a CLI-only reset, stop `npm run dev` if it is running, back up local state,
then regenerate deterministic demo state:

```bash
mv .local/state.json ".local/state.json.bak.$(date +%s)"
npm run bootstrap
npm run demo
```

## A task is unclear

```bash
npm run task -- OAF-004
```

Read its stop condition and required files. Do not expand scope to compensate for ambiguity; file an RFC or issue.

## An adapter cannot be enabled

That is expected. All researched adapters ship disabled and unpinned. Follow `skills/adapter-addition/SKILL.md` and do not run install scripts before security and license review.

## CI fails after generated local files

`npm run bootstrap` creates `.env` and `.local/`; both are ignored. `npm run check` deliberately ignores them. Do not add them to the repository.

## Hook command is unavailable or not firing

Use the read-only hook payload directly:

```bash
oaf hook context --read-only --format text
```

Preview hook snippets with:

```bash
npm run oaf -- hook install --agent codex --dry-run --format json
npm run oaf -- hook install --agent claude-code --dry-run --format json
npm run oaf -- connect codex --dry-run --format json
npm run oaf -- connect claude-code --dry-run --format json
```

The hook commands do not edit home config. `connect --dry-run` previews the
combined MCP and hook setup; `connect --yes` writes only Codex or Claude Code
OAF entries, creates backups, and reports a receipt.

## Tarball install check

Build and install the local tarball from a throwaway directory:

```bash
npm pack
tmp_home="$(mktemp -d)"
HOME="$tmp_home" npm install -g ./open-agent-fabric-0.2.0-dev.tgz --ignore-scripts --no-audit --no-fund
HOME="$tmp_home" oaf hook install --agent codex --dry-run --format json
HOME="$tmp_home" oaf hook install --agent claude-code --dry-run --format json
HOME="$tmp_home" oaf connect codex --dry-run --format json
```

The tarball install does not publish to npm. Keep setup in dry-run mode unless
you intentionally use `connect --yes` against the throwaway home directory.

## MCP fallback check

For an MCP-compatible stdio client, verify the read-only resource list:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"resources/list"}' | \
  oaf mcp resources --read-only --stdio
```

The fallback exposes resources only. It does not expose write tools or mutate
canonical state.

## Pinned pack is stale or blocked

Check the registry first:

```bash
npm run oaf -- context registry status --read-only --format json
```

If the current pin is stale, rebuild and pin from the current checkout, then
run `context receive --read-only` again.

## Manual setup rollback

Run uninstall dry-run before editing home config:

```bash
npm run oaf -- harness setup uninstall --client codex --server oaf --dry-run --format json
npm run oaf -- hook uninstall --agent codex --dry-run --format json
npm run oaf -- disconnect codex --dry-run --format json
```

Remove only `mcpServers.oaf` and OAF hook blocks that match the dry-run report,
or use `disconnect codex --yes` to remove OAF-owned entries with a backup and
receipt. Then verify with `harness setup status --dry-run` again.

## Benchmark interpretation

Use `benchmark truth-floor` as the product-readiness smoke for safe evidence
selection. Use `eval:context-recall` for the deeper tracked-repo recall and
budget sweep. Neither command is a provider billing-token claim, production
latency claim, or downstream task-quality judge.
