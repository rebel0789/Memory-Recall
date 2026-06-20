# OAF-028 Protocol Bridges Note

OAF-028 implements MCP exposure first through `packages/protocol-bridges`.

The bridge is dependency-free and in-process. It implements MCP-shaped
JSON-RPC request handling for initialization, tool/resource discovery, tool
calls, resource reads, ping, disconnect, and cancellation. It does not create a
stdio transport, HTTP transport, SSE stream, hosted service, or network
listener.

Authority remains OAF-owned:

- protected methods require an active trusted principal and workspace
  membership supplied by the OAF runtime, not the caller;
- caller-supplied role, owner, principal, membership, trusted context, grant,
  grant token, authorization, cookie, and external-write authority fields are
  rejected;
- tool calls consume one exact server-side grant matching workspace, tool,
  operation, side-effect class, and expiry;
- replay mode rejects side-effecting tools before invocation;
- disconnect aborts in-flight calls and rejects later requests;
- malformed messages and private result payloads fail closed.

Protocol compatibility adds `mcp-bridge-request.schema.json`, a valid
`tools/call` example, and an invalid top-level grant-token fixture.

OAF-028 does not implement A2A, AG-UI, ACP, or CCCC because there are no
accepted use-case RFCs for those bridges. The CCCC adapter remains planned,
disabled, unpinned, and unsupported.
