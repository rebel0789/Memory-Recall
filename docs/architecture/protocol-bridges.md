# Protocol Bridges

Protocol bridges translate standard agent protocol messages into OAF-owned
runtime operations. They do not grant identity, workspace membership, tool
authority, filesystem access, network access, or external-write permission.

## MCP Bridge

OAF-028 adds `packages/protocol-bridges` with a dependency-free MCP-shaped
JSON-RPC bridge. It supports:

- `initialize` and `ping`;
- `tools/list` and `resources/list`;
- `resources/read`;
- `tools/call` with server-side exact grant verification.

The package is in-process only. It does not start a stdio server, HTTP server,
SSE stream, hosted bridge, or network listener. Application composition can
wrap it later, but the bridge itself keeps transport separate from authority.

OAF-031 adds a local read-only resource catalog on top of this bridge. The CLI
composition:

```bash
npm run oaf -- mcp resources --read-only --format json
npm --silent run oaf -- mcp resources --read-only --stdio
```

exposes sanitized resources for workspace status, the latest context manifest,
the latest run, memory proposals, and the latest handoff/artifact summary. The
stdio mode reads JSON-RPC messages from stdin and writes JSON-RPC responses to
stdout; it does not bind a socket, start a public listener, expose write tools,
or grant client-supplied authority.

When launched with `--context-pack --objective ... --step ...`, the same
read-only composition also exposes
`oaf://workspace/<workspaceId>/context-pack/current`. This is a compact JSON
summary of an in-memory context pack: selected and omitted locators, token
counts, delivery-budget metrics for the locator-only handoff, fingerprints,
changed locators, source-graph impact, utility coverage counts, and safeguards.
It intentionally omits raw objective text, raw step text, markdown bodies,
source bodies, credentials, provider URLs, absolute local paths, model calls,
network calls, memory activation, external adapters, and write tools.

`npm run oaf -- mcp smoke context-pack --read-only ...` proves the same path by
launching the local stdio composition, sending JSON-RPC `resources/list`,
`tools/list`, and `resources/read` messages, and returning a schema-validated
local measurement report. The report records observed duration, byte counts,
selected/candidate source units, and delivered-handoff units for that one
invocation only; it is not a hosted benchmark or performance claim.

For a harness that needs a stable artifact, `context pack --write --use-out`
can also write a schema-validated use plan under
`context-packs/*.use.json`. The use plan is separate from the markdown pack:
the pack remains a dry-run handoff object, while the write report truthfully
records the local files written. A harness can then launch:

```bash
npm --silent run oaf -- mcp resources --read-only \
  --context-pack-use context-packs/CONTEXT_PACK.use.json --stdio
```

This exposes
`oaf://workspace/<workspaceId>/context-pack/use-plan/current`, a complete
sanitized required-read plan with locators, content hashes, coverage, delivery
metrics, pack fingerprints, and safety flags. It does not expose the raw
objective, raw step, launch prompt, markdown content, source content, provider
URLs, absolute filesystem locations, write tools, model calls, network calls,
external adapters, or home config writes.

When the user wants to reuse the same exported handoff later, the CLI can pin
the local artifacts explicitly:

```bash
npm --silent run oaf -- context pack --from codex --root . \
  --objective "Ship safely" --step "handoff" --target codex \
  --write --pin --out context-packs/CONTEXT_PACK.md --format json
```

Pinning writes `context-packs/CONTEXT_PACK.md`,
`context-packs/CONTEXT_PACK.use.json`, `context-packs/registry.json`, and
`context-packs/current.json`. The pack object still reports dry-run semantics;
the separate registry records artifact hashes, use-plan fingerprints,
required-read hashes, coverage, and current-pointer metadata. Verification is
read-only:

```bash
npm --silent run oaf -- context registry status --read-only --format json
npm --silent run oaf -- mcp resources --read-only \
  --context-pack-registry \
  --uri oaf://workspace/ws_local/context-pack/registry/current --format json
```

The registry status detects tampered markdown/use-plan artifacts, stale source
hashes, and modified registry/current-pointer fingerprints without returning
markdown bodies, objective text, source bodies, absolute local paths, model
calls, network calls, write tools, active memory, or external adapters.

## Authority

The bridge rejects caller-supplied authority fields such as role, owner,
principal, membership, trusted context, grant token, authorization, cookies, and
external-write flags. Tool calls consume an OAF-created grant whose workspace,
tool name, operation, side-effect class, and expiry match exactly.

Replay mode denies side-effecting tools before invocation. Disconnect aborts
in-flight handlers and rejects later requests. Bridge events include method,
tool name, grant ID, status, and input fingerprints only.

## Pending Protocols

A2A, AG-UI, ACP, and CCCC require accepted use-case RFCs before implementation.
The checked-in CCCC adapter remains planned, disabled, unpinned, and
unsupported.
