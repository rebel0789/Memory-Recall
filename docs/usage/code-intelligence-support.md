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
- `unmeasured`: the Phase 0 benchmark has not evaluated the claim;
- `does-not-meet-floor`: measured evidence missed at least one required floor;
- `meets-floor`: measured evidence passed every required floor.

A `meets-floor` capability requires both a deterministic fixture and evidence
from a pinned real repository. The audit rejects absolute paths, repository
escapes, missing evidence files, duplicate languages, incomplete capability
rows, and full claims without both evidence classes.

## Current boundary

The production-facing Node.js path remains bounded JavaScript and TypeScript
static analysis. It is the only code-intelligence path marked implemented in
Phase 0. The repository also contains a Rust Tree-sitter engine with broader
parsing and structural behavior, but npm does not yet ship its binary and the
public CLI, MCP tools, and web workbench do not use it. Those rows are
experimental or specified, and every benchmark status starts as unmeasured.

This boundary changes only when implementation, fixtures, pinned repository
results, package verification, and public documentation land together.

## Phase 0 evidence and next phase

The clean current-state receipt is
[`phase0-baseline.json`](../../evals/code-intelligence/results/phase0-baseline.json).
It records successful public JS/TS tests, the Rust build and test suite, and the
existing Rust ingest, typed-call, and incremental harnesses. It stores command
hashes and measurements, not raw command output. GitNexus and Codebase Memory
MCP are `unmeasured`, so the receipt proves neither parity nor leadership.

Phase 1 connects Node.js to the Rust engine through the versioned JSON Lines
boundary, adds compatibility and failure-isolation tests, and keeps the current
JS/TS path available until the native path passes equivalent public gates.
