---
name: oaf-memory
description: Map a project into governed, current OAF memory using the host agent's own intelligence. Reads decision logs, docs, config, code structure, and recent changes; extracts entity/relationship/decision facts and temporal supersessions; records them into OAF's local memory through the proposal gate so any coding agent later gets correct, current, governed context. Trigger when the user says "map this project into OAF", "remember my decisions", "/oaf-memory", or sets up OAF memory on a repo.
---

# OAF Memory Mapper

You are the **ingestion brain** for Open Agent Fabric (OAF) memory. OAF's core is
deliberately local and model-free, so its built-in heuristic ingest is dumb: it
cannot understand that "expiry is now 15 min, replaces 60 min." **You can.** Your
job is to read a project the way a senior engineer would, build a map of its
entities, relationships, and decisions, detect what has *changed over time*, and
record that map into OAF's governed memory.

This skill turns the host agent into the semantic extractor. The output is not a
static graph: you produce **governed, temporally-correct facts** that OAF keeps
current and serves to coding agents over MCP.

OAF also has a deterministic Rust structural pass for local documents:

```bash
oaf ingest-docs --root . --sqlite .local/memory.sqlite --format json
```

Use that pass first when the user asks for broad docs ingestion. It extracts
markdown/text/PDF document structure, ADR status/decision lines, and explicit ADR
supersession into proposal-gated facts without model calls. Then use this skill
only for semantic facts the structural pass cannot know: rationale, cross-file
meaning, changed defaults, unresolved conflicts, and project-specific intent.
Do not duplicate structural facts already proposed by `ingest-docs`.

## When to use

- The user asks to "map this project into OAF", "remember my decisions", "set up
  OAF memory here", or invokes `/oaf-memory`.
- Before handing a repo to another coding agent, so that agent inherits the
  current, correct context instead of re-deriving (and re-sending) it.

## The contract you must honor

- **Governed, never silent.** Everything you record goes through OAF's proposal
  gate. You propose; the user approves. Never auto-activate facts.
- **Current truth, not history.** When a value changed, record the NEW value and
  mark it as superseding the old one. Do not record stale values as if current.
- **Provenance always.** Every fact cites a workspace-relative source.
- **Safe.** Workspace-relative locators only. Never record secrets, tokens, keys,
  credentials, absolute paths, or raw file bodies. Skip anything unsafe.

## Procedure

### Step 1 — Discover high-signal sources (process in chunks)

Scan the repo and rank sources by how much durable knowledge they carry. Read the
high-value ones first; for large repos, batch them in chunks of a handful of files
rather than reading everything at once.

Priority order:
1. **Decision logs / ADRs** — `DECISIONS.md`, `docs/adr/**`, `docs/architecture/**`,
   `CHANGELOG.md`. These hold the decisions and their evolution. Highest value.
2. **Project identity / config** — `package.json`, `PROJECT_STATUS.json`,
   `pyproject.toml`, `*.config.*`, manifests, `compose.yaml`. Defaults and choices.
3. **README / docs** — stated architecture, conventions, constraints.
4. **Recent git history** — `git log --oneline -20` and recent diffs, to catch
   decisions that changed in code but not yet in docs.
5. **Code structure** — key modules, exported APIs, provider/adapter wiring. Use
   the directory layout and exports; do not transcribe code bodies.

Derive the project subject from the actual repo (package name or folder), e.g.
`project:notes-api` — never a hardcoded name.

**Complement, don't duplicate.** OAF's built-in
`oaf memory ingest` already captures the cheap structural facts for free — commit
subjects, file/module structure, config defaults. Do **not** re-extract those.
Spend your intelligence on what heuristics provably cannot do: **decisions, the
rationale behind them (WHY), what changed over time (supersession), and cross-file
relationships.** That division keeps source extraction cheap while reserving
host-agent judgment for meaning.

**Scale with parallel chunks.** For a large repo, do not read everything in one
pass. Split the high-signal sources into chunks of a handful of files and dispatch
a subagent per chunk to extract its fragment in parallel, then merge the fragments
into one `facts.json` (dedup by `subject|predicate|object`). This is the core
scalability technique. For a small repo, a single pass is fine.

### Step 2 — Extract the fact map

For each source, extract durable facts as `{subject, predicate, object, source}`
triples. Together these form a governed map of the project. Capture three kinds:

- **Entities & relationships** (the map):
  `notes-api | uses | hmac-tokens`, `auth.mjs | exports | issueToken`,
  `notes-api | default_storage | sqlite`.
- **Decisions & defaults** (what an agent must respect):
  `auth | token_expiry | 15 minutes`, `project | network_policy | deny-by-default`.
- **Constraints / conventions**:
  `tests | runner | node --test`, `commits | style | conventional`.

Rules for good facts:
- Subjects/predicates are short, lowercase, **deterministic** identifiers
  (`snake_case`); the same entity must always produce the same subject id so it
  dedups across chunks. Objects are a short value or identifier.
- Prefer durable, load-bearing facts an agent would need to act correctly. Skip
  trivia, formatting, and ephemeral noise.
- One fact = one claim. Do not pack multiple claims into one object string.

**Predicate vocabulary.** Prefer a controlled set so the map stays queryable.
Reach for these first; only invent a new predicate when none fits:
`uses`, `depends_on`, `implements`, `exposes`, `default`, `config`, `decision`,
`constraint`, `convention`, `owns`, `relates_to`.

**Confidence (the audit trail).** Tag every fact with how you know it:
- `extracted` — stated explicitly in a source (a decision log line, a config
  value). Record it.
- `inferred` — a reasonable read of the code/structure, not stated outright.
  Record it, but say so in `notes`.
- `ambiguous` — you are unsure it is current or correct. Surface it in the dry-run
  for the user to confirm; do not record it silently.
Never guess a value to fill a gap — an unknown is better than a wrong fact.

### Step 3 — Detect temporal supersession (the part heuristics cannot do)

This is your highest-value contribution. Whenever the content shows a value
**changed over time**, record the current value and mark the supersession:

- Append-only decision logs with a later entry ("2026-03: now 15 min, supersedes
  the 60 min decision") → record `auth | token_expiry | 15 minutes` with
  `supersedes: {subject: auth, predicate: token_expiry}`.
- Language signals: "now", "replaces", "supersedes", "deprecated", "migrated to",
  "changed from X to Y", a newer ADR overriding an older one.
- Git history showing a default changed in code.

When in doubt about whether something is current, prefer the most recent dated or
committed source, and note lower confidence in `notes`.

### Step 4 — Sanitize

Before recording, drop any fact whose object or source contains a secret, token,
key, credential, cookie, authorization header, provider URL, absolute filesystem
path, or raw source body. Rewrite sources as workspace-relative locators
(`workspace://DECISIONS.md`). When unsure, skip the fact.

### Step 5 — Dry-run review (governance)

Write the extracted facts to `facts.json` (schema below) and **show the user a
concise summary first** — grouped as: new facts, supersessions (old → new), and
anything skipped as unsafe or uncertain. Wait for the user to confirm before
recording. Do not record silently.

### Step 6 — Record through OAF

Record the reviewed facts in one governed batch:

```bash
oaf memory remember --batch facts.json --root . --sqlite .local/memory.sqlite --format json
```

For conversational memory, write host-extracted candidates to a batch with a
workspace-relative transcript source and let OAF consolidate them against current
memory:

```json
{
  "transcriptSource": "workspace://chat-export.json",
  "facts": [
    {
      "subject": "user:local",
      "predicate": "default",
      "object": "editor = vim",
      "source": "workspace://chat-export.json",
      "confidence": "extracted"
    }
  ]
}
```

```bash
oaf memory consolidate --batch facts.json --root . --sqlite .local/memory.sqlite --format json
```

`consolidate` retrieves similar current facts with local Random Indexing, decides
ADD / UPDATE / DELETE / NOOP per candidate, emits a consolidation receipt, and
queues only consequential proposals. Transcript content is always treated as
`untrusted_external`; do not mark conversational candidates as verified.

This routes every fact through OAF's proposal gate. Then, only with the user's
approval, promote them:

```bash
oaf memory review  --root . --sqlite .local/memory.sqlite --format json
oaf memory approve --root . --sqlite .local/memory.sqlite --all-from "workspace://DECISIONS.md" --format json
```

### Step 7 — Verify and report

Confirm the map landed correctly, especially supersession. For each key decision,
recall it and check the CURRENT value is returned and the stale one is absent:

```bash
oaf memory search "token expiry" --root . --sqlite .local/memory.sqlite --format json
```

Then report: how many facts mapped, how many supersessions recorded, sources
covered, and anything skipped — so the user sees exactly what OAF now knows.

## facts.json schema

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
      "notes": "2026-03 security review; replaces the 60-minute decision"
    },
    {
      "subject": "notes-api",
      "predicate": "default",
      "object": "storage = sqlite",
      "confidence": "inferred",
      "source": "workspace://package.json",
      "notes": "inferred from dependencies; not stated in a decision log"
    }
  ]
}
```

`confidence` is one of `extracted` | `inferred` | `ambiguous`. `supersedes` and
`notes` are optional. Omit `supersedes` for a brand-new fact.

## Boundaries

- Never call an external service yourself; OAF makes no model calls — *you* are the
  intelligence, running inside the host agent.
- Never auto-approve. Proposal → human review → approve is mandatory.
- Never record secrets, absolute paths, or raw source bodies.
- Keep the map focused on durable, load-bearing knowledge. A tight map of correct
  current facts beats a huge map of noise.
