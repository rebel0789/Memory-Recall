# Threat Model

## Assets

Canonical events, workspace data, source bodies, memories, policies, approvals, workflow definitions, prompts, model output, tool grants, credentials, and release artifacts.

## Adversaries

- malicious or compromised external content;
- a compromised model or adapter;
- an over-permissioned agent;
- a local process reading secrets or state;
- a remote attacker reaching an exposed service;
- a dependency or update supply-chain compromise;
- an authorized user making an accidental consequential action.

## Primary threats

### Goal and instruction hijacking

External text tries to redefine the objective, request secrets, enable tools, or bypass policy. Mitigation: isolate instructions from data, label trust, select context deterministically, and deny capability changes from retrieved content.

### Tool misuse and privilege escalation

A model requests undeclared files, domains, secrets, or operations. Mitigation: manifest, short-lived grant, sandbox, default deny, timeout, output limit, and independent policy.

### Malformed API input reaches domain execution

External HTTP requests may be oversized, malformed, ambiguous, compressed, cross-origin, or shaped to trigger parser edge cases before local services execute. Mitigation: the control API validates route contracts at the boundary before stores, workflow runners, Context Compiler, model providers, artifact stores, tool providers, or migration code are called. It enforces body, URL, header, query, path, JSON depth, node, object-key, and array limits; rejects unsupported media types and content encodings; validates responses before sending JSON; and returns stable sanitized error envelopes with correlation IDs.

OAF-008 extends the boundary with native local authentication and deterministic workspace authorization. Non-public routes require an authenticated principal before stores, workflows, the Context Compiler, native providers, or migration code are called. The enforced order is request limits, route matching, path/query/header/body validation, correlation ID, credential extraction, authentication, workspace resolution, authorization, CSRF for cookie-auth unsafe requests, domain handler, and response validation.

### Local identity and workspace authorization

Browser sessions are opaque server-side records. The session cookie stores only a random token; the native provider stores a SHA-256 token hash and revokes the server-side record on logout. Login rotates active sessions. CSRF uses a readable SameSite=Strict cookie plus matching `x-csrf-token` header, and the session stores only a hash bound to that session. Bearer API tokens are exempt from CSRF but cannot create or manage API tokens.

Passwords use Node `crypto.scrypt` with a unique random salt and a versioned serialized credential. Password input is length-bounded, is not trimmed or normalized, rejects null bytes, and unknown usernames verify against a dummy credential path before returning the same public `invalid_credentials` error.

Workspace context is explicit per protected route. Direct workspace operations return `403 forbidden` when the authenticated principal lacks authority. Resource-specific lookups such as run detail return `404 resource_not_found` for inaccessible or missing resources. The role/action matrix is deterministic: owner has all actions; builder has workspace/dashboard/run/context/stream actions; operator has workspace/dashboard/run/stream actions; auditor has read and audit actions only.

API tokens are created only from a session protected by CSRF, are returned raw once, are stored as hashes, and are checked against user status, active memberships, allowed workspaces, scopes, expiration, and revocation.

### Memory poisoning

Untrusted or incorrect inference becomes permanent context. Mitigation: proposals, provenance, confidence, verification, user confirmation, lifecycle, supersession, quarantine, and retention.

### Cross-workspace leakage

Retrieval or storage returns another workspace's records. Mitigation: scope in every repository key and query, policy at service and repository layers, and explicit adversarial tests.

Artifact bodies are also scoped by workspace. The native filesystem provider derives object, record, tombstone, and export paths internally under `workspaces/<workspace-id>`, rejects unsupported workspace IDs, and does not deduplicate across workspaces. Exports contain relative paths only and must not reveal absolute local storage paths.

### Cascading and repeated side effects

Retries or agent loops publish, delete, or change permissions more than once. Mitigation: durable coordination, idempotency, exact approval binding, bounded retries, reconciliation, and compensation.

### Secret exfiltration

Credentials enter prompts, logs, events, errors, tool output, or source snapshots. Mitigation: secret references, redaction, egress controls, no raw secrets in model context, and test fixtures that contain no real credentials.

API error mapping must never include raw request bodies, authorization headers, cookies, tokens, SQL, filesystem paths, environment variables, stack traces, or submitted values. Structured API logs are limited to safe codes, operation IDs, statuses, durations, and correlation IDs.

Source snapshots reject URL userinfo and secret-like provenance keys such as authorization, cookies, tokens, passwords, credentials, and signed headers. They store collected material and provenance only; summaries, hooks, classifications, model conclusions, and memory decisions remain separate records so untrusted source text cannot become policy or memory by storage alone.

### Artifact deletion and tampering

Local processes may corrupt stored objects, replace paths with symlinks, or delete records out of order. Mitigation: private directories, atomic temporary-file plus rename writes, symlink ancestor rejection, raw-byte hash verification, explicit retention application, idempotent tombstones, and integrity checks that report findings without auto-repair.

### Supply-chain compromise

An adapter, skill, model file, container, or installer changes behavior. Mitigation: exact pins, checksums, signatures where available, SBOM, provenance, no runtime download of instructions, and reviewed update pull requests.

## Security assumptions

The bootstrap is a development environment and binds locally. It now provides local-first authentication and workspace authorization, but it does not provide production SSO, MFA, encrypted-at-rest storage, hardened sandboxing, hosted secret management, or production deployment hardening. These are release gates, not implied features.

## Review triggers

Any broadened network/filesystem access, new secret scope, external write, cookie automation, deletion behavior, remote protocol, dynamic code loading, or license boundary requires security review.
