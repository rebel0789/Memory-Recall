# External Adapter Conformance

Every adapter directory contains a versioned `adapter.json`, `UPSTREAM.lock`, trust-boundary notes, and `fixtures/conformance.json`.

The fixture is a **contract expectation**, not a claim that the adapter is implemented or passing. An adapter may move to `experimental` only after executable code passes these cases and records the run in its manifest.

## Required executable cases before promotion

1. Dependency absent or unhealthy fails closed.
2. Capabilities are discoverable without invoking a side effect.
3. Missing or insufficient grants prevent invocation.
4. Malformed provider output cannot mutate canonical state.
5. Timeout and cancellation are bounded.
6. Output size and schema are enforced.
7. Source and provider metadata are preserved.
8. Clean disable and uninstall leave canonical state readable.

## Promotion evidence

A promotion pull request must include:

- exact upstream commit and archive checksum;
- reviewed SPDX license and notices;
- executable conformance output;
- permission and prompt-injection tests;
- supported operating systems and versions;
- maintainer and update plan.
