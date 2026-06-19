# Golden Path

The bootstrap golden path is intentionally deterministic:

```text
synthetic observations
→ normalized records
→ forced policy and constraint
→ bounded Context Compiler
→ three deterministic candidates
→ citation verification
→ append-only events
→ inspectable dashboard
```

Acceptance:

```bash
npm run bootstrap
npm run ci
npm run demo
npm run dev
curl -fsS http://127.0.0.1:4310/api/health
curl -fsS -X POST -H 'content-type: application/json' \
  -d '{"workflowId":"workflow:content-intelligence"}' \
  http://127.0.0.1:4310/api/runs
```

The run must remain local-only, contain exactly three recommendations, and verify every recommendation evidence ID against selected observations.
