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

## Phase 2 Tier 1 evidence

The Phase 2 receipt is
[`phase2-tier1-summary.json`](../../evals/code-intelligence/results/phase2-tier1-summary.json).
It aggregates 14 deterministic fixtures and all 42 pinned repositories. Every
case passes its reviewed truth, determinism, duplicate-symbol, parse-failure,
and safety gates. The summary does not average failures away: any failed case
would block the affected capability row.

The ratios below are reviewed samples, not whole-repository recall. A
capability moves to `meets-floor` only when the fixture and all three pinned
repositories contain qualifying reviewed evidence. An applicable capability
with narrower evidence stays `unmeasured`, even when every sampled item passes.

| Language | Declarations | Relationships | Reviewed calls | Capability rows at floor | Applicable rows still unmeasured | Overall |
| --- | ---: | ---: | ---: | --- | --- | --- |
| TypeScript | 6/6 | 6/6 | 4/4 | parse, structure, calls | imports, exports, types | unmeasured |
| JavaScript | 5/5 | 6/6 | 4/4 | parse, structure, imports, calls | exports, types | unmeasured |
| Python | 16/16 | 9/9 | 4/4 | parse, structure, calls | imports, heritage, types, config, frameworks | unmeasured |
| Java | 21/21 | 7/7 | 5/5 | parse, structure, calls | imports, heritage, types, frameworks | unmeasured |
| Kotlin | 20/20 | 8/8 | 4/4 | parse, structure | imports, heritage, types, calls, frameworks | unmeasured |
| C# | 23/23 | 7/7 | 5/5 | parse, structure, calls | imports, heritage, types, frameworks | unmeasured |
| Go | 19/19 | 5/5 | 4/4 | parse, structure, calls | imports, types, config, frameworks | unmeasured |
| Rust | 23/23 | 11/11 | 4/4 | parse, structure, types, calls | imports, heritage, config, frameworks | unmeasured |
| PHP | 18/18 | 12/12 | 4/4 | parse, structure, heritage, calls | imports, types, frameworks | unmeasured |
| Ruby | 17/17 | 11/11 | 4/4 | parse, structure, calls | imports, heritage, types, frameworks | unmeasured |
| Swift | 16/16 | 10/10 | 1/1 | parse, structure, heritage, types | imports, calls, frameworks | unmeasured |
| C | 14/14 | 6/6 | 4/4 | parse, structure, calls | imports, types, config | unmeasured |
| C++ | 15/15 | 6/6 | 4/4 | parse, structure, calls | imports, heritage, types, config | unmeasured |
| Dart | 17/17 | 15/15 | 3/3 | parse, structure, imports, types | exports, heritage, calls, config, frameworks | unmeasured |

Across the 154 Tier 1 capability cells, 46 meet the Phase 2 floor, none has a
recorded floor failure, and 108 remain unmeasured or not applicable. Six
repository scopes hit the configured node or edge budget and report the exact
omitted counts; their available reviewed evidence remains usable and partial.

Reproduce the stored batch receipts and aggregate from a source checkout with a
local release binary:

```bash
node scripts/code-intelligence-batch-a.mjs --check
node scripts/code-intelligence-batch-b.mjs --check
node scripts/code-intelligence-batch-c.mjs --check
node scripts/code-intelligence-batch-d.mjs --check
node scripts/code-intelligence-batch-e.mjs --check
node scripts/code-intelligence-phase2-tier1.mjs --check
```

Phase 2 does not bundle a native binary, change the JS public default, move MCP
or web to Rust, prove multi-repository or million-node behavior, compare a
competitor, or justify parity or leadership language.

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
