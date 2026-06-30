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
```

Open <http://127.0.0.1:4310>, create or sign in to the local owner if prompted,
then click **Run local demo**. Protected dashboard actions use browser session
cookies and CSRF protection; unauthenticated `curl` requests to `/api/runs` are
expected to fail. For a CLI-only path, use `npm run demo` or create the local
owner with `npm run auth:bootstrap -- --password-stdin` before using
authenticated API examples.

The run must remain local-only, contain exactly three recommendations, and verify every recommendation evidence ID against selected observations.
