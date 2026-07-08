# Product Contract

## Public name

**Memory Recall** is the public name. Architecture and internal package contracts
must not depend on the marketing name; existing OAF identifiers remain
compatibility/internal IDs until a planned migration needs them.

## Promise

A local-first control plane that lets people build, run, inspect, and improve agents without surrendering their models, memory, workflows, or evidence to one vendor.

## Primary users

- **Solo builder:** needs a coherent local stack instead of hand-wiring models, tools, memory, workflows, logs, and approvals.
- **Creator or researcher:** needs repeatable research, evidence-backed angles, source traceability, and outcome learning without generic automated writing.
- **Platform engineer:** needs stable contracts, durable execution, context governance, conformance tests, and cross-model observability.
- **Operator or auditor:** needs to know what ran, what was selected, what was excluded, which permissions applied, and who approved consequential actions.

## Product pillars

1. **Selection over accumulation.** Context is compiled to a budget, not dumped into a prompt.
2. **Durability over chat history.** Runs are evented, resumable, replayable, and inspectable.
3. **Capabilities over integrations.** Tools declare permissions, risk, inputs, outputs, and side effects.
4. **Evidence over eloquence.** Claims link to sources; model interpretations remain distinct from observations.
5. **Local by default.** The bootstrap works offline. Networked adapters are explicit.
6. **Replaceability over lock-in.** Models, stores, workflow engines, and frameworks sit behind contracts.

## Flagship workflow

```text
collect → normalize → deduplicate → detect patterns → select evidence
→ generate angles → approve → draft → verify → publish → measure → learn
```

## v0.1 scope

- Local workspace and run management.
- Append-only event ledger.
- Context Compiler v1.
- Deterministic model plus explicit local model adapter.
- MCP-compatible tool registry contract.
- Versioned memory proposals and write gate.
- Content Intelligence with file and RSS inputs.
- Run Timeline, Context Inspector, Evidence Explorer, Memory Explorer, and Approval Inbox.
- Deterministic tests and regression evaluations.

## Functional requirements

### Workspace

- Create and select a local workspace.
- Show whether storage, models, tools, and runs are local or networked.
- Export workspace-owned portable data.

### Runs

- Start a versioned workflow.
- View state, steps, events, artifacts, failures, and duration.
- Resume or replay according to step semantics.
- Deep-link to a run and selected step.

### Context

- Compile context from normalized records.
- Show selected and excluded records with reasons and token cost.
- Show conflicts, supersession, scope, provenance, and compiler version.
- Compare manifests across runs or selector versions.

### Evidence

- Store immutable source metadata and content hashes.
- Keep observations separate from model inference.
- Build deterministic citation graphs with deduplication groups, claim edges, staleness, and conflict findings.
- Require evidence IDs for material generated claims.
- Surface stale, missing, or conflicting evidence.

### Memory

- Propose rather than silently persist memory.
- Gate stable facts, decisions, preferences, and procedures.
- Version and supersede records rather than overwrite.
- Export and expire records by policy.

### Tools and approvals

- Register typed tool manifests.
- Evaluate role, network, filesystem, secrets, cost, sandbox, and risk.
- Require exact previews, approval IDs, and idempotency for consequential writes.
- Record authorization and results as events.

### Models

- Use a deterministic mock without network.
- Support explicit local model endpoints.
- Route through a stable gateway contract.
- Record model, prompt, schema, context manifest, usage, and validation metadata.

## User experience requirements

- Outcome, explanation, and trace are separate disclosure levels.
- Chat never becomes the only place state exists.
- Every major resource has a stable URL.
- Keyboard, mobile, reduced-motion, and non-color status requirements meet `DESIGN.md`.
- Specified or unavailable features are labeled, not presented as functional.

## Security requirements

- Default-deny network and filesystem policy.
- No plaintext secrets in prompts, events, logs, or fixtures.
- Untrusted content cannot grant capabilities, change policy, or write permanent memory.
- External writes disabled by default.
- Every adapter pinned, licensed, reviewed, tested, and isolated before support.

## Acceptance for 0.1

A new contributor can clone the repository, run the offline bootstrap and CI, inspect a complete content-research run, understand selected and excluded context, change a deterministic selector rule with a regression evaluation, and add a disabled adapter skeleton without reading provider internals.

## Out of scope

- General autonomous employment,
- unreviewed publishing,
- payments,
- production multi-region hosting,
- custom foundation-model training,
- automatic ingestion of all private communications,
- claims of general intelligence or universal reliability.
