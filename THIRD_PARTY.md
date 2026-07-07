# Third-Party Integration Policy

External projects are research inputs, benchmark inputs, or optional integration targets. **No upstream source is vendored in this kit.** OAF owns the default local tool experience. Before enabling an integration, pin an exact commit, verify its current license, inspect install scripts and network behavior, generate an SBOM, define a maintainer, and run conformance and adversarial tests.

| Project | Intended role | Boundary |
|---|---|---|
| session-memory adapter research | session memory and progressive retrieval | optional local adapter |
| code-graph adapter research | code/document knowledge graph | optional CLI adapter |
| design-artifact adapter research | design artifact generation | optional MCP/CLI adapter |
| recent-public-research adapter | recent public research | optional read adapter |
| multi-model-review adapter | multi-model review | optional CLI adapter |
| read-side-research router | read-side research routing | optional CLI adapter |
| collaboration-service bridge | agent collaboration | optional service bridge |
| repository-intelligence adapter | repository intelligence | optional CLI adapter |
| governed conversational-memory research | extract-then-consolidate ADD/UPDATE/DELETE/NOOP operation patterns | research input only; no upstream source is vendored or copied |
| temporal-knowledge research | episode/fact separation, bi-temporal invalidation, and hybrid graph retrieval patterns | research input only; no upstream source is vendored or copied |
| code-intelligence research | Random Indexing, co-occurrence, MinHash, and code-graph ranking techniques | research input only; no upstream source is vendored or copied |
| pdf-extract | local PDF text extraction for governed document ingest | Rust crate `pdf-extract` 0.12.0, MIT, used only inside native local document ingestion; no cloud service, OCR, or external database |
| ECC | source of reviewed procedures | `adapter:tool:ecc` is pinned at `34faa39bd3cd496a0aece0245f2b7e38b7923abc`, archive SHA-256 `c4a147dfb3766ee4eaedf74efbbc62cb5cdab014a5df98bee67020fb05871ae0`, MIT reviewed, no-install, experimental, disabled by default, and never bulk-loaded |
| context-backend experiment | context backend experiment | isolated adapter |
| social-publishing service | social publishing | separate approved-write service |

Every adapter ships disabled and `UNPINNED`. Repository names and license notes are planning metadata, not a current legal conclusion. Re-verify at the exact commit before integration.
