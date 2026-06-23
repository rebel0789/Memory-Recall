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
