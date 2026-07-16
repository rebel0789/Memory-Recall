# Uninstall and Preserve Local Data

Memory Recall has no `recall uninstall` command and no data-delete command.
The current uninstall paths never delete `.local`. `recall uninstall --dry-run`
is the required preview boundary for any future local-state deletion flow, but
it does not exist today. Do not invent it, substitute another command, or treat
`recall uninstall --confirm` as available: automatic local-data deletion is
unsupported.

`recall setup` creates `.local/state.json` and `.local/artifacts`; SQLite memory
and MCP cursor or stats files can appear there after you use their related
commands. Keep that directory if you may return to the repository.

## 1. Preview the installed path

First identify whether you used the connect-owned resource bridge or the
tool-server installer:

```bash
# Connect-owned resource bridge and hooks (Codex or Claude Code only).
recall disconnect codex --dry-run --format json

# Tool-server install preview (Codex, Claude Code, or Cursor).
recall mcp install --client codex --dry-run --format json

# Manual-only previews; these do not remove anything.
recall harness setup uninstall --client codex --server oaf --dry-run --format json
recall hook uninstall --agent codex --dry-run --format json
```

Replace `codex` with `claude-code` where appropriate. Use `cursor` only with
the tool-server preview. The last two commands are reports for manual removal,
not uninstall writers.

## 2. Remove a connect-owned resource bridge

If you previously ran `recall connect codex --yes` or
`recall connect claude-code --yes`, inspect the dry-run receipt, then repeat the
same client with `--yes`:

```bash
recall disconnect codex --yes --format json
```

This removes only matching Memory Recall resource-bridge and hook entries. If
it changes an existing home config, it records a `*.oaf-backup-*` backup. It
does not remove a tool-server entry installed by `recall mcp install`.

## 3. Remove a tool-server install

`recall mcp install --apply` has no automatic uninstall command and does not
create a backup. Review a fresh dry-run report, then remove only its named
server entry from the displayed config:

- Codex: remove `[mcp_servers.oaf]` from `$HOME/.codex/config.toml`.
- Claude Code and Cursor: remove `mcpServers.oaf` from the displayed JSON
  config only.

Do not remove neighboring MCP servers, and do not use `recall disconnect` for
this path: the tool server is intentionally different from the resource bridge.

## 4. Remove the package

After client configuration is gone, remove the global package if you no longer
need the CLI:

```bash
npm uninstall -g memory-recall
```

This removes the installed package and executable. It does not touch any
repository's `.local` directory, home-config backups, or manually created
context packs.

The checkout-only native consumer gate verifies this boundary on the current
platform: removing both exact root and native packages leaves source, governed
memory, home configuration, and the SQLite index bundle byte-identical. A fresh
same-version install reopens that generation without rebuilding it. This is not
evidence that an older release can read state written by a newer release.

## 5. Preserve or intentionally manage `.local`

Before any manual cleanup, inspect and back up the directory outside the
repository if it contains memory you need:

```bash
find .local -maxdepth 2 -type f -print
```

No command on this page removes `.local`, and Memory Recall never removes it
without a product-provided named confirmation command. No such data-delete
command exists today. If you decide to erase local data later, use your
platform's reviewed backup-and-trash workflow outside Memory Recall; that is a
separate, irreversible decision.
