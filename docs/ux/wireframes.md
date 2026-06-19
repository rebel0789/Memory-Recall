# Low-Fidelity Wireframes

## Run detail

```text
┌ Navigation ┐ ┌ Run: content-intelligence              [Completed] ┐
│ Home       │ │ Outcome: 3 evidence-backed candidates              │
│ Runs       │ │ Local-only · deterministic-v1 · 0.2 s              │
│ Context    │ ├──────────────────────────────────────────────────────┤
│ Memory     │ │ Steps                           Inspector            │
│ Evidence   │ │ ✓ Collect                       selected step        │
│ Workflows  │ │ ✓ Normalize                     inputs / output      │
│ Approvals  │ │ ✓ Compile context               context manifest    │
│ Settings   │ │ ✓ Generate angles               events / validation │
└────────────┘ └──────────────────────────────────────────────────────┘
```

## Context Inspector

```text
┌ Context ctx_... · 161 / 180 tokens · 0 conflicts ┐
│ [Selected 6] [Excluded 4] [Assembly] [Compare]   │
├────────────────────────────┬───────────────────────┤
│ policy: evidence required  │ forced governance     │
│ 22 tokens · policy         │ scope · source        │
├────────────────────────────┼───────────────────────┤
│ observation: messy...      │ task relevance        │
│ 31 tokens · source         │ score · time · trust  │
└────────────────────────────┴───────────────────────┘
```

## Approval

```text
┌ Approval required: Publish X post ─────────────────────────┐
│ Destination: account @example                              │
│ Risk: public consequential write                           │
│ Exact content: [preview]                                   │
│ Evidence: 4 sources · Similarity: passed                   │
│ Expires: 15 minutes · Idempotency: pub_...                 │
│                                                           │
│ [Reject]                                 [Approve once]    │
└───────────────────────────────────────────────────────────┘
```
