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
| Hosted memory backend candidate | memory backend | optional memory adapter |
| ECC | source of reviewed procedures | `adapter:tool:ecc` is pinned at `34faa39bd3cd496a0aece0245f2b7e38b7923abc`, archive SHA-256 `c4a147dfb3766ee4eaedf74efbbc62cb5cdab014a5df98bee67020fb05871ae0`, MIT reviewed, no-install, experimental, disabled by default, and never bulk-loaded |
| OpenViking | context backend experiment | isolated adapter |
| Postiz | social publishing | separate approved-write service |

Every adapter ships disabled and `UNPINNED`. Repository names and license notes are planning metadata, not a current legal conclusion. Re-verify at the exact commit before integration.
