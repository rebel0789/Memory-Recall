# ADR 0023: Production Rust code-intelligence engine

## Status

Accepted.

## Decision

Rust owns the production code-intelligence engine: repository discovery,
language detection, parsing, structural extraction, graph construction, and
incremental index updates. The engine emits a versioned, provider-neutral
JSON Lines protocol. It does not expose Tree-sitter node shapes, grammar crate
names, provider identifiers, absolute paths, or source bodies as public
identity.

Node.js remains the product shell. It owns the CLI, loopback Control API,
governed memory workflow, read-only MCP surface, and web workbench. Node.js
starts the native engine, validates every protocol record, applies product
bounds and authorization, and converts results into Memory Recall contracts.
The process boundary keeps parser failure isolated from the long-running
product services.

Indexes and caches produced by the engine are derived local state. Canonical
memory, approvals, handoffs, and provenance continue to use the existing
governed stores and protocols. A derived index may be deleted and rebuilt
without changing canonical product state.

Published npm packages include signed platform binaries for supported targets.
Normal installation and use require no local Rust toolchain. Unsupported
platforms fail with a clear diagnostic instead of compiling during install or
silently falling back to a weaker parser.

## Consequences

- The existing Rust Tree-sitter implementation becomes the only production
  parser path after compatibility and benchmark gates pass.
- The current JavaScript and TypeScript provider remains available during the
  measured migration, then becomes an explicit fallback or is retired.
- The native protocol must be deterministic, bounded, versioned, and covered by
  compatibility fixtures before the production switch.
- Parser and index data stay local by default. Network access is not part of
  scanning, indexing, or querying.
- Native release artifacts require checksums, signatures, smoke tests, and npm
  package verification for every supported platform.
