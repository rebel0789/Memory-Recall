# Security Model

Memory Recall is local-first and review-first.

The [developer-first product contract](../product/memory-recall-developer-first.md)
defines the `implemented`, `experimental`, and `unsupported` capability
boundaries. Normal commands use `recall`; [OAF compatibility](oaf-compatibility.md)
records preserved legacy identifiers and URIs.

## Defaults

| Boundary | Default |
| --- | --- |
| Network | Denied unless a command explicitly needs it. |
| Model calls | None for setup, handoff, memory ingest, and local benches. |
| MCP tools | Read-only by default. |
| External writes | Disabled. |
| Memory writes | Proposal-gated, never silent. |
| Config writes | Dry-run first, confirm-gated. |
| Secrets | Secret-like memory proposals are quarantined. |

## What Agents Can Read

Agents can receive:

- reviewed active memory facts;
- context-pack locators;
- changed-file coverage;
- required local reads;
- hashes and proof commands;
- read-only MCP resources.

Normal handoffs do not include raw source bodies.

## What Agents Cannot Do By Default

- Approve memory.
- Modify harness config.
- Run shell commands through MCP.
- Call cloud APIs.
- Enable external adapters.
- Publish, deploy, or write to third-party services.

## Related Docs

- [Threat model](../security/threat-model.md)
- [Prompt injection](../security/prompt-injection.md)
- [Secrets](../security/secrets.md)
- [Tool permissions](../security/tool-permissions.md)
- [Supply chain](../security/supply-chain.md)
