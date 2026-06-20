# Secrets

Use references such as `secret://workspace/provider/token`, never raw values in domain objects.

## Requirements

- local development may use an ignored `.env`, but prompts and events receive references only;
- production uses a reviewed encrypted secret backend;
- adapters declare exact secret scopes;
- tool workers receive only required secrets for one grant;
- OAF-015 tool handlers resolve declared secret references only after policy
  allow and one-use grant consumption;
- logs redact common credential forms and authorization headers;
- error messages never echo environment variables;
- rotation and revocation are documented;
- source snapshots, memory, and exports reject secret material.

The repository check scans common patterns but is not a substitute for dedicated secret scanning in the hosted repository.

Bounded tool execution must never persist or emit raw grant tokens, resolved
secret values, provider URLs, authorization headers, cookies, local paths, or
hidden reasoning. Tests cover declared-reference resolution, undeclared-secret
denial, and output leakage failure.
