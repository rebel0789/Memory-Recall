# ADR 0018: Native Bounded Tool Execution

## Status

Accepted for OAF-015.

## Context

The bootstrap had manifest-shaped tool declarations and policy checks, but the
runtime still allowed caller-supplied authority in the tool path and did not
prove one-use grants, brokered filesystem/egress/secrets, or durable
idempotent local writes.

## Decision

Add `provider:native:tool:brokered-local` as the native conformance baseline.
It loads only reviewed checksum-pinned entries from `tools/catalog.json`,
evaluates OAF-009 policy for each exact operation, mints a one-use
short-lived in-memory grant after allow, and independently brokers filesystem,
loopback egress, and secret references. Local writes must use the OAF-014
durable idempotent effect boundary.

The provider executes reviewed in-process handlers only. It does not claim
arbitrary-code sandboxing, run shell commands, download tools, browse, publish,
call public internet hosts, enable external adapters, or enable external
writes.

## Consequences

- Native providers remain conformance baselines.
- External adapters and external writes stay disabled.
- Raw grant tokens, prompts, context bodies, outputs, credentials, provider
  URLs, local paths, and hidden reasoning stay out of events and logs.
- Future stronger sandboxing must be introduced behind a new reviewed provider
  or adapter contract rather than by widening this baseline.
