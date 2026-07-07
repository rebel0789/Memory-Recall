# Architecture Research Source Catalog

This catalog preserves the source set that informed the development kit. It is a map for future adapter research—not a list of installed dependencies or current endorsements. Before using an upstream, record an exact commit, checksum, license review, maintainer, trust boundary, and conformance evidence.

## Product and interface guidance

- [Vercel Web Interface Guidelines](https://vercel.com/design/guidelines) — interaction, accessibility, URL state, forms, motion, and performance review input.
- [Vercel design context](https://vercel.com/design.md) — research input for agent-consumable product guidance.
- [shadcn/ui](https://ui.shadcn.com/docs) — open-code component model considered for the future production interface.

## Research and content capabilities

- [Agent-Reach](https://github.com/Panniantong/agent-reach) — optional read-side research capability router.
- [last30days-skill](https://github.com/mvanhorn/last30days-skill) — optional recent public-signal research adapter.
- [Postiz](https://github.com/gitroomhq/postiz-app) — optional, separately deployed publishing target; consequential writes remain disabled by default.

## Memory and context

- [Microsoft ISE A2A context passing](https://devblogs.microsoft.com/ise/a2a-context-passing-multi-agent-systems/) — coordinator-provided embedded context pattern for stateless receiver agents.
- [Experience Compression Spectrum](https://arxiv.org/abs/2604.15877) — research input for tiering raw traces, memory, skills, and rules by compression level.
- [MemRefine](https://arxiv.org/abs/2606.13177) — memory-compaction research input; any OAF use stays proposal-gated and read-only before approval.
- [Deployment-Time Memorization](https://arxiv.org/abs/2606.10062) — memory deletion, derived-summary residue, and extraction-risk threat-model input.
- [claude-mem](https://github.com/thedotmack/claude-mem) — progressive session-memory retrieval research.
- [Graphiti](https://github.com/getzep/graphiti) — temporal graph memory research with provenance and changing facts.
- [Mem0](https://github.com/mem0ai/mem0) — optional memory backend research.
- [OpenViking](https://github.com/volcengine/OpenViking) — filesystem-oriented context research.
- [HydraDB](https://hydradb.com/) — temporal/relational selection thesis; commercial dependency is not required.
- [DataHub context management](https://datahub.com/blog/context-management/) — governance, lineage, access-control, and auditability framing for organization-wide context.
- User-provided article: “Your AI Agents Don't Have a Memory Problem. They Have a Selection Problem” — thesis input for the Context Compiler.

## Code and knowledge intelligence

- [Neo4j Labs create-context-graph](https://github.com/neo4j-labs/create-context-graph) — context-graph application scaffold for graph, document browser, and decision-trace research.
- [Graphify](https://github.com/safishamsi/graphify) — optional code/document graph adapter.
- [Understand Anything](https://github.com/Egonex-AI/Understand-Anything) — optional repository-intelligence adapter.
- [ECC](https://github.com/affaan-m/ECC) — procedures and harness patterns to audit and curate, never bulk-load.

## Collaboration, models, and design

- [CCCC](https://github.com/ChesterRa/cccc) — optional collaboration bridge, not the canonical workflow engine.
- [Oracle](https://github.com/steipete/oracle) — optional multi-model review adapter.
- [Open Design](https://github.com/nexu-io/open-design) — optional local design artifact adapter.

## Core infrastructure candidates

- [Temporal integrations](https://docs.temporal.io/integrations) — durable workflow target.
- [pgvector](https://github.com/pgvector/pgvector) — semantic candidate generation alongside lexical retrieval.
- [LangGraph](https://github.com/langchain-ai/langgraph) — optional bounded reasoning adapter.
- [LiteLLM](https://docs.litellm.ai/docs/) — optional model gateway implementation behind OAF contracts.
- [Model Context Protocol](https://github.com/modelcontextprotocol) — tool/resource interoperability target.
- [TrueFoundry Skills Registry](https://www.truefoundry.com/blog/introducing-skills-registry-reusable-agent-skills-for-production-ai-systems) — skill metadata, on-demand loading, and governed procedural-context registry pattern.
- [TrueFoundry MCP Gateway Registry](https://www.truefoundry.com/blog/mcp-gateway-registry) — MCP tool discovery, schema, permission, and approval governance pattern.
- [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/) — telemetry contract input.
- [Langfuse self-hosting](https://langfuse.com/self-hosting) — optional evaluation/trace frontend.
- [OpenFGA](https://github.com/openfga/openfga) and [OPA](https://www.openpolicyagent.org/) — future authorization and contextual policy implementations.
- [E2B](https://github.com/e2b-dev/e2b) and Daytona — future sandbox adapter research.
- [GitHub orchestrator repository search](https://github.com/search?q=orchestrator&type=repositories&s=stars&o=desc) — discovery input only; popularity is not architecture evidence.

## Research rules

1. Prefer official upstream documentation and exact repository commits.
2. Treat stars, marketing claims, and vendor benchmarks as weak evidence.
3. Never run install scripts from a moving branch in a privileged agent session.
4. Keep upstream IDs and payloads out of canonical OAF domain contracts.
5. Re-test removal: the core must continue to run when an adapter is absent.
