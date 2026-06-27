# OAF Memory Mapper

Use this skill in Claude Code, Cursor, or Codex by copying `skills/oaf-memory/SKILL.md` into that client’s skill/rules folder, then invoke `/oaf-memory` in the target repo.

The host agent reads the repo, shows a dry-run review, and writes `facts.json`. OAF records the reviewed map locally, behind the proposal gate:

```bash
oaf memory remember --batch facts.json --root . --sqlite .local/memory.sqlite --format json
oaf memory review --root . --sqlite .local/memory.sqlite --format json
oaf memory approve --all-from workspace://DECISIONS.md --root . --sqlite .local/memory.sqlite --format json
oaf memory search "token expiry" --root . --sqlite .local/memory.sqlite --format json
```

Schema:

```json
{
  "facts": [
    {
      "subject": "auth",
      "predicate": "decision",
      "object": "token_expiry = 15 minutes",
      "confidence": "extracted",
      "source": "workspace://DECISIONS.md",
      "supersedes": { "subject": "auth", "predicate": "decision" },
      "notes": "replaces 60 minutes"
    }
  ]
}
```

`confidence` is `extracted`, `inferred`, or `ambiguous` and defaults to `extracted`. `source` must be a `workspace://` path inside `--root`. Unsafe facts are skipped; OAF makes no model calls.
