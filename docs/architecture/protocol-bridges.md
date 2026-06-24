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
counts, fingerprints, changed locators, source-graph impact, and safeguards.
It intentionally omits raw objective text, raw step text, markdown bodies,
source bodies, credentials, provider URLs, absolute local paths, model calls,
network calls, memory activation, external adapters, and write tools.

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
