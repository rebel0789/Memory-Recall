# Tool Manifests

A manifest is the maximum capability surface, not a grant. The runtime evaluates actor, workspace, input, files, network, secrets, data class, cost, sandbox, approval, and idempotency before every invocation. `publish` is intentionally unusable in the bootstrap.

OAF-015 uses `tools/catalog.json` as the reviewed checksum-pinned catalog for
native bounded tool execution. Enabled catalog entries must point to reviewed
`schemaVersion: 1.1.0` manifests with explicit operations and handler bindings.

Only the brokered local provider consumes this catalog. It supports deterministic
fixtures, workspace-relative filesystem reads/writes, loopback reads, and
declared secret references. It does not enable external adapters, arbitrary
shell execution, downloaded tools, browser automation, public internet access,
or publishing.
