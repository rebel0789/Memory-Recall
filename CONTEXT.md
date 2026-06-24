# Open Agent Fabric

Open Agent Fabric is a local-first context and reliability system for coding agents. This glossary defines the product language agents should use when planning, implementing, or reviewing work in this repository.

## Language

**Local Context Operating System**:
A local control layer that gives coding agents selected context, memory proposals, source evidence, tool authority, and replayable run state without making a hosted service or a single harness the system of record.
_Avoid_: Agent dashboard, hosted memory SaaS, universal automation platform, codebase-memory clone

**Context Quality Ranking**:
The product priority order for context work: correct and safe context first, token efficiency second, speed third, and harness breadth fourth. OAF should only claim optimization when required evidence and safety are preserved.
_Avoid_: Token savings at any cost, fastest response wins, broad harness support as proof of quality

**Safe Context Layer**:
The first public beta promise: OAF runs locally and gives coding agents safe, token-efficient repository and memory context through context packs, read-only MCP resources, and proposal-gated memory writes.
_Avoid_: Hidden transcript upload, automatic cloud memory, invisible context injection, write-enabled MCP by default

**Proposal-Gated Memory Import**:
The rule that imported harness context or transcript-derived learnings can become memory proposals, but cannot become active memory until the user reviews and accepts them. Users choose which Codex, Claude Code, Cursor, or other harness sources OAF may inspect.
_Avoid_: Automatic active memory, silent transcript capture, default import from hidden app state

**Read-Only MCP Surface**:
The first MCP exposure for OAF: resources that let harnesses inspect status, context packs, manifests, source graph results, memory proposals, accepted-memory summaries, benchmark reports, and handoff bundles without mutating OAF state.
_Avoid_: Write-enabled MCP by default, memory write tools before exact grants, MCP resources with hidden side effects

**Native Source Graph**:
A local derived index over normalized OAF source records, symbols, imports, calls, routes, tests, configuration, evidence, memory proposals, context manifests, and benchmark cases. It should support graph search, structural filters, call/data-flow traces, architecture summaries, diff impact, and bounded context selection while remaining an index, not canonical state.
Current implementation exposes a read-only JS/TS graph preview for search, call trace, and diff impact through CLI/API. It is not a persisted graph database and does not create memory.
Context packs also include compact source graph hints as locators and fingerprints only; they do not embed raw code slices.
_Avoid_: Source graph as canonical memory, graph database requirement, silent adapter enablement, mutating graph tools by default, token-saving claims without OAF benchmarks
