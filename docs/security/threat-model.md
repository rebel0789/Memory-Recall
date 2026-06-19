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

OAF-008 extends the boundary with native local authentication and deterministic workspace authorization. Non-public routes require an authenticated principal before stores, workflows, the Context Compiler, native providers, or migration code are called. OAF-009 then centralizes contextual policy decisions before domain or tool execution. The enforced order is request limits, route matching, path/query/header/body validation, correlation ID, credential extraction, authentication, trusted workspace and membership resolution, contextual policy evaluation, CSRF for cookie-auth unsafe requests, domain or tool handler, policy/audit event recording, and response validation.

Policy denials stop before workflow start, Context Compiler invocation, artifact or memory mutation, model/tool invocation, filesystem write, secret resolution, external network operation, or consequential side effect.

### Local identity and workspace authorization

Browser sessions are opaque server-side records. The session cookie stores only a random token; the native provider stores a SHA-256 token hash and revokes the server-side record on logout. Login rotates active sessions. CSRF uses a readable SameSite=Strict cookie plus matching `x-csrf-token` header, and the session stores only a hash bound to that session. Bearer API tokens are exempt from CSRF but cannot create or manage API tokens.

Passwords use Node `crypto.scrypt` with a unique random salt and a versioned serialized credential. Password input is length-bounded, is not trimmed or normalized, rejects null bytes, and unknown usernames verify against a dummy credential path before returning the same public `invalid_credentials` error.

Workspace context is explicit per protected route. Direct workspace operations return `403 forbidden` when the authenticated principal lacks authority. Resource-specific lookups such as run detail return `404 resource_not_found` for inaccessible or missing resources. The role/action matrix is deterministic: owner has all actions; builder has workspace/dashboard/run/context/stream actions; operator has workspace/dashboard/run/stream actions; auditor has read and audit actions only.

API tokens are created only from a session protected by CSRF, are returned raw once, are stored as hashes, and are checked against user status, active memberships, allowed workspaces, scopes, expiration, and revocation.

### Contextual policy

Authentication answers who the principal is. Workspace authorization answers which current role the principal holds. Contextual policy answers whether that principal may perform one exact operation on one exact resource with one exact capability and consequence profile.

The policy registry is committed source with a semantic version and deterministic SHA-256 fingerprint. It defines known actions, resource types, role/action permissions, data classes, side-effect classes, budget ceilings, approval and idempotency requirements, tool-capability dimensions, and hard global kill switches. Unknown registry fields fail startup/test validation.

Policy input is strict and server-populated. It can carry safe IDs, membership status, resource type, data class, capability requests, approval metadata, idempotency keys, and trusted timestamps. It cannot carry passwords, cookies, bearer token values, CSRF tokens, secret values, authorization headers, model reasoning, prompts, source bodies, or executable policy text.

Default deny covers missing identity/workspace/membership/action, unknown actions/resources, unsupported roles, workspace mismatch, token-scope mismatch, unregistered tools, undeclared operations, capability requests wider than the manifest, filesystem/network/secret/data-class/sandbox/budget violations, missing or mismatched approval, missing idempotency, and globally disabled external writes.

Models, skills, retrieved content, tool output, and adapter responses may request a capability but cannot grant authority. Approval is necessary for consequential writes but never sufficient by itself; exact operation fingerprints, idempotency, policy permission, and the global external-write switch are still evaluated.

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
