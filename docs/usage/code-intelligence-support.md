# Code-intelligence language support

The authoritative support record is
[`evals/code-intelligence/capability-matrix.v1.json`](../../evals/code-intelligence/capability-matrix.v1.json).
It records product status, benchmark status, evidence, and limitations for every
language and capability. This page explains how to read it; it does not repeat
the matrix cells.

## Language tiers

Tier 1 is the release target: TypeScript, JavaScript, Python, Java, Kotlin, C#,
Go, Rust, PHP, Ruby, Swift, C, C++, and Dart. All fourteen must meet the
published quality floors before Memory Recall can claim Tier 1 parity.

Tier 2 contains Lua, Bash, SQL, Objective-C, Scala, R, Julia, and Zig. Their
parsers remain experimental until each language passes the same evidence gates.
Parser availability alone is not product support.

## Status meanings

Product status and benchmark status answer different questions:

- `implemented`: behavior is available through the current public product path;
- `experimental`: behavior exists only on an unbundled or manual path;
- `specified`: the target contract exists, but qualifying behavior does not;
- `unsupported`: no implementation is present;
- `unmeasured`: the published accuracy benchmark has not evaluated the claim;
- `does-not-meet-floor`: measured evidence missed at least one required floor;
- `meets-floor`: measured evidence passed every required floor.

A `meets-floor` capability requires both a deterministic fixture and evidence
from a pinned real repository. The audit rejects absolute paths, repository
escapes, missing evidence files, duplicate languages, incomplete capability
rows, and full claims without both evidence classes.

## Current boundary

The production-facing Node.js path remains bounded JavaScript and TypeScript
static analysis. Phase 1 adds an explicit `native-preview` engine to graph CLI
reads. It requires a locally built Rust binary supplied through
`MEMORY_RECALL_NATIVE_BINARY`; npm does not ship that binary. MCP tools, the web
workbench, and graph commands without `--engine` continue to use the Node path.
Other languages remain experimental or specified and are not public graph
support.

This boundary changes only when implementation, fixtures, pinned repository
results, package verification, and public documentation land together.

## Phase 1 evidence

The reproducible receipt is
[`phase1-js-ts-compatibility.json`](../../evals/code-intelligence/results/phase1-js-ts-compatibility.json).
It covers TypeScript and JavaScript fixtures, a bounded scope from the pinned
TypeScript compiler commit, and the full pinned Express commit. Both engines
run twice per case under the same file, byte, node, and edge limits.

The boundary gate passes: all four cases complete, fingerprints are stable, the
two real repositories match their pinned commits, and no engine network, model,
memory, or workspace write is reported. The compatibility measurements do not
pass the published accuracy floor. The real-repository results show unresolved
native import and call gaps. Therefore `native-preview` remains explicit and
non-default, benchmark status remains `unmeasured`, and no parity claim is made.

Reproduce the stored evidence from a source checkout with a local release
binary:

```bash
node scripts/code-intelligence-phase1-compatibility.mjs --check
```

## Earlier baseline

The clean current-state receipt is
[`phase0-baseline.json`](../../evals/code-intelligence/results/phase0-baseline.json).
It records successful public JS/TS tests, the Rust build and test suite, and the
existing Rust ingest, typed-call, and incremental harnesses. It stores command
hashes and measurements, not raw command output. Competitor performance remains
unmeasured, so neither receipt proves parity or leadership.
