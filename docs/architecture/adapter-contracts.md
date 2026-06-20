# Adapter Contracts

Adapters translate external systems into OAF domain contracts. They do not redefine canonical identity, policy, events, or memory semantics.

## Required metadata

- exact upstream repository and commit;
- archive or source checksum;
- reviewed license and notices;
- maintainer and review date;
- supported platforms and versions;
- required processes, files, domains, and secrets;
- input/output limits and timeout;
- side-effect class;
- sandbox profile;
- health and conformance evidence.

## Lifecycle

```text
planned → pinned → reviewed → experimental → supported → deprecated → removed
```

No adapter skips `pinned` and `reviewed`. Supported status requires release evidence; popularity is not evidence.

## Conformance

Test success, malformed output, timeout, cancellation, partial output, oversized data, prompt injection, permission denial, unavailable dependency, upstream version mismatch, and clean removal.

`ArtifactStorePort` is versioned as `1.1.0` for the native artifact baseline. Implementations keep the compatibility methods `put`, `get`, `list`, and `remove`, and add explicit methods for source snapshots, metadata reads, body reads, integrity verification, retention planning/application, tombstoned record removal, and portable workspace export. Public results expose record IDs, hashes, sizes, schema versions, and relative export paths, never provider filesystem handles or absolute storage paths.

## Isolation

Prefer subprocess, container, or service boundaries for complex or restrictive upstream projects. The Apache core must operate without every optional adapter.

## Native providers versus external adapters

`providers/native/` contains local implementations maintained as part of OAF. `adapters/` contains external integration boundaries. Both implement provider-neutral ports, but only external adapters require an upstream pin and third-party license review.

Every external adapter now carries a `fixtures/conformance.json` expectation. The fixture does not mean the adapter works; it describes the minimum cases executable code must pass before promotion.

OAF-027 promotes exactly one adapter, `adapter:tool:ecc`, to `experimental`.
It is a no-install `SkillSourcePort` adapter for reviewed procedure proposals
only. It records an exact upstream commit, archive checksum, MIT license
review, executable conformance output, and adversarial tests while remaining
disabled by default. The adapter does not run ECC installers or scripts,
vendor upstream source, bulk-load skills, execute networked instructions, or
mutate canonical state directly.

## Dependency boundary

```text
packages/* domain contracts
      ↑                  ↑
providers/native/*   adapters/*
      ↑                  ↑
application composition selects one
```

Core packages never import either provider family. Provider payloads enter canonical state only after validation and normalization.

## Policy boundary

Adapters do not authorize themselves. Any adapter or native tool operation must
receive an allow decision from the contextual policy service before execution.
The adapter manifest describes maximum possible capability; the invocation
request may only narrow it. Model output, retrieved content, skill text, adapter
metadata, or upstream SDK responses cannot grant filesystem, network, secret,
data-class, approval, budget, or external-write authority.

External adapters remain disabled by default. OAF-009 adds the policy boundary
and conformance tests; OAF-027 adds one disabled experimental ECC adapter. This
does not enable Agent-Reach, last30days, Postiz, browser automation,
publishing, network connectors, external writes, or any bulk adapter catalog.
