# Policy Package

`packages/policy` owns the deterministic contextual policy engine for OAF-009.
It is not a public policy-evaluation API and it does not authenticate users.
OAF-008 authentication resolves the principal, current workspace membership, and
API-token scope first; this package evaluates whether that trusted principal may
perform one exact operation.

## Source Of Truth

The committed registry in `src/index.mjs` defines known actions, resource
types, role permissions, data classes, side-effect classes, budget defaults,
approval binding, idempotency requirements, and the global external-write kill
switch. `policyFingerprint()` produces a deterministic SHA-256 fingerprint so
policy changes are reviewable as source diffs.

Route authorization and tool invocation both call `createPolicyService()` and
`evaluateContextualPolicy()`. The legacy `evaluatePolicy()`, `actionsForRole()`,
and `authorizeWorkspaceAction()` exports remain compatibility wrappers only.

## Request Rules

Policy requests are strict, versioned, and server-populated. They may contain
safe principal IDs, workspace IDs, membership role/status, resource IDs, tool
capability requests, approval metadata, idempotency keys, and trusted timestamps.
They must not contain passwords, cookies, bearer token values, CSRF tokens,
secret values, authorization headers, model reasoning, or executable policy
text.

Unknown, missing, malformed, unsupported, or over-broad dimensions default to
deny with stable reason codes.

## Tool Capabilities

A trusted tool manifest declares the maximum possible capability. Invocation may
only narrow that manifest. Filesystem read/write scopes, network destinations,
secret references, data classes, sandbox profile, side-effect class, and budgets
are evaluated independently. Model output, skill text, retrieved content, and
adapter responses cannot widen capability.

## Events

`createPolicyService()` emits a safe `policy.decision` audit event for every
allow or deny when a `SecurityAuditSinkPort` is supplied. Events include the
decision ID, correlation ID, actor ID, workspace ID, action, resource type,
outcome, reason codes, policy version, fingerprint, evaluated timestamp, and a
safe operation ID. They exclude raw secrets, credentials, prompts, raw payloads,
absolute filesystem paths, SQL, stack traces, and complete external URLs.
