# RFC 0001 — Provider-Neutral Protocol Contracts

**Status:** Draft for OAF-002

## Goal

Freeze additive v1 contracts for events, context requests and manifests, memory records, tool/skill/agent/adapter manifests, content observations, workflows, approvals, artifacts, and error envelopes.

OAF-015 extends the v1 protocol additively with reviewed tool catalogs,
reviewed tool manifests, handler descriptors, sandbox profile names, invocation
requests, safe grant records, invocation results, reconciliation metadata, safe
tool event payloads, and stable tool error codes.

## Requirements

- canonical IDs are independent of providers;
- every workspace-owned object carries workspace scope;
- every event supports correlation and causation;
- temporal and provenance fields are explicit;
- data classification and schema version are explicit;
- unknown major versions fail clearly;
- unknown additive fields survive round trips where practical;
- raw secrets and large source bodies are references, not payload fields.
- raw grant tokens, raw prompts, tool outputs, secret values, provider URLs,
  local paths, and caller-supplied authority fields are not protocol payloads.

## Open questions for OAF-002

- Exact compatibility policy for optional versus required additive fields.
- Whether event payload schemas share one registry or remain package-local.
- Canonical error code namespaces.
- Serialization requirements for hashes and large integer usage.

## Acceptance

Valid, invalid, and backward-compatibility fixtures pass deterministic tests. No adapter-specific identifier becomes canonical identity.
