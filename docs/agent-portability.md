# OAF Agent Portability

OAF installs as a local MCP server plus the `oaf-memory` skill. Runtime stays
local: no OAF model calls, no cloud database, no network.

| Agent | Install surface | Config written by `oaf setup` | Tier support |
| --- | --- | --- | --- |
| Claude Code | native plugin manifest + MCP | `.claude/mcp.json`, `.claude-plugin/*` | lite/full/ultra |
| Codex | plugin manifest + MCP | `.codex/config.toml`, `.codex-plugin/plugin.json` | lite/full/ultra |
| Gemini CLI | extension manifest + MCP | `.gemini/settings.json`, `gemini-extension.json` | lite/full/ultra |
| OpenCode | plugin manifest + MCP | `.config/opencode/opencode.json`, `opencode.json` | lite/full/ultra |
| Cursor | MCP + rules fallback | `.cursor/mcp.json`, `.cursor/oaf-plugin.json` | lite/full/ultra |
| VS Code/Copilot | MCP config | `.vscode/mcp.json` | lite/full/ultra |
| Windsurf | MCP + rules fallback | `.windsurf/mcp.json`, `.windsurf/oaf-plugin.json` | lite/full/ultra |
| Kiro | MCP + rules fallback | `.kiro/mcp.json`, `.kiro/oaf-plugin.json` | lite/full/ultra |
| Other agents | instruction-tier fallback | `.oaf/AGENTS.md`, `plugin.yaml` | lite/full/ultra |

Tiers:

- `lite`: read-only governed memory recall.
- `full`: recall plus context, graph, architecture, and change-impact tools.
- `ultra`: full plus governed host-LLM graph-organization proposals.

Setup is receipt-first:

```bash
oaf setup --tier full --dry-run --format json
oaf setup --tier full --confirm <planFingerprint> --format json
```

`oaf setup` only writes under the chosen agent config home, stores no
credentials, and reports touched files before any write.
