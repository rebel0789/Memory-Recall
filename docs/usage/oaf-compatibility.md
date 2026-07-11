# OAF Compatibility

Memory Recall is the public product name, and normal quickstarts use `recall`.
This page records the older OAF identifiers that remain compatible.

## Preserved identifiers

- `oaf` is an executable compatibility alias for `recall`.
- `npm run oaf -- <command>` remains the source-checkout script alias.
- `oaf://` MCP resource URIs remain stable.
- `oaf` remains the MCP server key in generated harness configuration.
- Existing values such as `skill:oaf-memory` and `oaf.memory.json` remain
  protocol-compatible names.

## Migration rule

Use `recall` in normal user commands and examples. Do not remove or rename the
identifiers above: they are part of compatibility and protocol contracts. See
the [developer-first product contract](../product/memory-recall-developer-first.md)
for the supported capability boundary.
