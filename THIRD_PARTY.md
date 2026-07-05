# Third-Party Integration Policy

External projects are research inputs, benchmark inputs, or optional integration targets. **No upstream source is vendored in this kit.** OAF owns the default local tool experience. Before enabling an integration, pin an exact commit, verify its current license, inspect install scripts and network behavior, generate an SBOM, define a maintainer, and run conformance and adversarial tests.

| Project | Intended role | Boundary |
|---|---|---|
| claude-mem | session memory and progressive retrieval | optional local adapter |
| Graphify | code/document knowledge graph | optional CLI adapter |
| Open Design | design artifact generation | optional MCP/CLI adapter |
| last30days-skill | recent public research | optional read adapter |
| Oracle | multi-model review | optional CLI adapter |
| Agent-Reach | read-side research router | optional CLI adapter |
| CCCC | agent collaboration | optional service bridge |
| Understand Anything | repository intelligence | optional CLI adapter |
| Mem0 | memory backend | optional memory adapter |
| mem0 | research input for governed conversational-memory consolidation | `mem0ai/mem0`, Apache-2.0, studied for extract-then-consolidate ADD/UPDATE/DELETE/NOOP operation patterns; no upstream source is vendored or copied |
| Graphiti | research input for temporal knowledge modeling | `getzep/graphiti`, Apache-2.0, studied for episode/fact separation, bi-temporal invalidation, and hybrid graph retrieval patterns; no upstream source is vendored or copied |
| codebase-memory-mcp | research input for native code-intelligence algorithms | `DeusData/codebase-memory-mcp`, MIT, studied for Random Indexing, co-occurrence, MinHash, and code-graph ranking techniques; no upstream C source is vendored or copied |
| pdf-extract | local PDF text extraction for governed document ingest | Rust crate `pdf-extract` 0.12.0, MIT, used only inside native local document ingestion; no cloud service, OCR, or external database |
| ECC | source of reviewed procedures | `adapter:tool:ecc` is pinned at `34faa39bd3cd496a0aece0245f2b7e38b7923abc`, archive SHA-256 `c4a147dfb3766ee4eaedf74efbbc62cb5cdab014a5df98bee67020fb05871ae0`, MIT reviewed, no-install, experimental, disabled by default, and never bulk-loaded |
| OpenViking | context backend experiment | isolated adapter |
| Postiz | social publishing | separate approved-write service |

Every adapter ships disabled and `UNPINNED`. Repository names and license notes are planning metadata, not a current legal conclusion. Re-verify at the exact commit before integration.
