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
