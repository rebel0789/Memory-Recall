# Evaluations

Deterministic cases test context selection, harness context preview, policy,
memory-write behavior, workflow recovery, bounded tools, content intelligence,
and evaluation-lab invariants. Add a minimal regression case before changing
defaults.

`evals/harness-context/cases.json` is the preview-only token-efficiency and
leakage gate for documented Codex, Claude Code, and Cursor project files. It
measures required locator recall, distractor exclusion, selected-token ratio,
deterministic fingerprints, and absence of raw bodies, secrets, local paths,
model calls, network calls, source snapshots, active memory, adapter activation,
and external writes.

`evals/benchmark-truth-floor/cases.v1.json` is the schema-validated
gold-evidence truth floor. It compares native exact, full-context, lexical, and
current-harness baselines with deterministic ID/fingerprint scoring only. Run it
directly with:

```bash
npm run oaf -- benchmark truth-floor --suite benchmark-truth-floor --dataset evals/benchmark-truth-floor/cases.v1.json --format json
```

Exit `0` means the merge gate passed, exit `1` means the benchmark ran and the
gate failed, and exit `2` means the command or dataset was invalid. Reports
include IDs, counts, metrics, safe locators, and fingerprints; they do not
include raw prompts, context bodies, outputs, credentials, provider URLs, local
paths, hidden reasoning, model calls, network calls, adapter activation, active
memory, snapshots, or external writes.

The eval runner also checks the native AST code candidate source with a
temporary TypeScript workspace. It proves static JS/TS chunk discovery,
workspace locators, symbol/import metadata, Context Compiler integration,
read-only source-index queries for definitions, references, imports, exports,
callers, callees, file outlines, repository outlines, deterministic
fingerprints, and absence of raw source body or local path leakage. The source
is dependency-free and does not execute project code.

The persisted-manifest eval also checks manifest `etag`s, explicit token
accounting reports, and `deltaFrom` summaries between repeated local manifest
builds. These checks are deterministic and do not enable memory imports,
external adapters, model calls, or external writes.

OAF-026 adds `evals/lab` for versioned dataset, experiment, and report records.
Deterministic regression datasets are merge gates and run through
`npm run eval`. Model-quality suites are shadow-only by default and must not
change model, prompt, selector, tool, or workflow defaults without a reviewed
report and rollback plan.

Failed traces can become fixtures only through sanitized trace promotion. Store
fingerprints, safe attributes, provenance, and classification review, never raw
prompts, context bodies, outputs, credentials, provider URLs, local paths,
hidden reasoning, SQL, cookies, tokens, authorization material, or private
source bodies.
