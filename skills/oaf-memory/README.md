# OAF Memory Mapper

Use this skill in Claude Code, Cursor, or Codex by copying `skills/oaf-memory/SKILL.md` into that client’s skill/rules folder, then invoke `/oaf-memory` in the target repo.

The host agent reads the repo and writes `facts.json`; OAF only records reviewed facts locally:

```bash
oaf memory remember --batch facts.json --root . --sqlite .local/memory.sqlite --format json
oaf memory review --root . --sqlite .local/memory.sqlite --format json
oaf memory approve --all-from workspace://DECISIONS.md --root . --sqlite .local/memory.sqlite --format json
```

Schema:

```json
{
  "facts": [
    {
      "subject": "auth",
      "predicate": "token_expiry",
      "object": "15 minutes",
      "source": "workspace://DECISIONS.md",
      "supersedes": { "subject": "auth", "predicate": "token_expiry" },
      "notes": "replaces 60 minutes"
    }
  ]
}
```

`source` must be a `workspace://` path inside `--root`. Unsafe facts are skipped; OAF makes no model calls.
