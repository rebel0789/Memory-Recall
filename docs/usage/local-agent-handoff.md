# Local Agent Handoff Guide

This guide is the shortest path for using Open Agent Fabric today. It is for a
developer who wants to hand the current repository to another local coding
agent with less noise, explicit changed-file context, and proof that OAF did
not leak raw source bodies or perform hidden writes.

First run `npm run status`; when it reports `Next task: none`, use the
`First safe handoff` command it prints or continue below.

After registry publication, install globally with:

```bash
npm install -g open-agent-fabric
```

After a global install, the shortest useful command is:

```bash
oaf handoff
```

From the source checkout, the equivalent convenience script is:

```bash
npm run handoff:safe
```

To measure the same context-pack path as a token-saver report:

```bash
oaf token-saver
```

## What This Solves

Use OAF when a coding-agent session is about to continue work in the same repo
and you need a compact, reviewable handoff:

- selected local context locators instead of a giant pasted transcript;
- explicit changed-file impact and required local reads;
- source graph hints for JavaScript and TypeScript files;
- read-only MCP resource proof for local harnesses;
- a delivery-budget estimate for the handoff OAF actually gives the agent;
- safeguards showing zero model calls, network calls, external writes, adapter
  enablement, active memory creation, or source-body inclusion.

It is not a hosted memory service, automatic harness-history importer,
write-enabled MCP server, browser automation layer, or public publishing tool.

## One-Time Local Setup

From the repository root:

```bash
npm pack
npm install -g ./open-agent-fabric-1.0.0.tgz
oaf setup
oaf verify
```

Without a global install:

```bash
npm run oaf -- setup
npm run oaf -- verify
```

These are local wrappers for the existing bootstrap and handoff verification
gates. The package metadata is npm-ready; registry publication still requires
maintainer npm authentication and explicit approval. The marketplace manifest is
prepared, but submission still needs a published npm URL and target registry
requirements.
For the fully expanded source-checkout path:

`oaf setup` is checkout bootstrap, not harness wiring. Use browser **Preview
setup** or `oaf harness setup plan/status --dry-run` when you want a manual MCP
config preview for Codex, Cursor, or Claude Code.

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run bootstrap
npm run doctor
npm run verify:handoff
npm run status
npm run dev
```

Open <http://127.0.0.1:4310/context-pack>. If local owner setup is required,
complete it in the browser or bootstrap from stdin:

```bash
printf '%s\n' 'correct horse battery staple' | \
  npm run auth:bootstrap -- --username owner --display-name "Local Owner" --password-stdin
```

Do not pass local passwords as command arguments.

## Browser Path

Use this path when you want to inspect the pack before copying it into another
agent session.

1. Open **Context Pack** and start at **Create a first local handoff**.
2. In **Inputs to review**, choose a target: Codex, Claude Code, Cursor, or
   Generic agent.
3. Leave source families at Codex unless you explicitly want to inspect Claude
   Code or Cursor project files.
4. Click **Preview sources**.
5. Click **Detect current git changes**, or enter changed relative paths
   manually.
6. Optionally enter reviewed workspace-relative files under **Memory preflight
   sources (optional)**. The browser can copy or download `oaf.memory.json`; it
   does not send those paths to the context-pack API or read memory bodies.
7. Click **Build context pack**.
8. Start with **Practical handoff**: copy the Markdown or launch prompt, copy
   or download `oaf.memory.json` only if you entered memory proposal files, then
   copy and run **Test local handoff** for reproducible read-only CLI/MCP proof.
9. For durable reuse, click **Pin locally**, then **Receive pinned pack**. The
   browser reads the pinned registry/use-plan and shows a copyable receiver
   packet without rebuilding the pack or accepting objective/step text.
10. Review **Use this pack**, **First-use readiness**, selected locators,
   omissions, changed-file coverage, and proof commands when you need deeper
   trace detail.
11. Use **Preview setup** when you want a generated Codex, Cursor, or Claude
   Code MCP config snippet. The snippet is a manual-copy template only; OAF
   does not write harness config files.

The browser path writes context-pack files only when you click **Pin locally**.
It does not mutate harness configs, call models, use network access, enable
external adapters, or create active memory.

## CLI Path

Use this path when you want a repeatable command before launching the next
agent.

For the default Codex handoff summary over the current repository and local git
changes:

```bash
oaf handoff
```

For an explicit JSON report:

```bash
oaf context handoff \
  --read-only \
  --from codex \
  --root . \
  --objective "Prepare handoff" \
  --step "select next agent context" \
  --target codex \
  --changed apps/web/app.js \
  --format json
```

The report returns a launch prompt, required local reads, use-plan fingerprint,
MCP context-pack readback proof, harness setup dry-run status, and zero-tool
MCP proof.

Use `--target a2a` when the next worker is another agent service. OAF still
builds coordinator-selected embedded context with versioned typed safe parts, required
local reads, and read-only resource URIs; it does not create shared agent state,
write tools, active memory, raw source bodies, or external credentials.

Use `--format summary` for a compact operator view over the same read-only
proof. The summary reports statuses, counts, and fingerprints, not launch
prompt text or source bodies.

If you want to review possible durable memories from files you selected, add a
workspace-relative `--memory-config oaf.memory.json`. The config must name
explicit `memoryPaths`; the handoff report only returns counts, warning codes,
fingerprints, and the matching dry-run `memory proposals` command. It does not
create proposal Markdown, activate memory, import harness transcripts, or include
memory/source text in the report. Do not point `memoryPaths` at OAF-generated
outputs such as `memory/profile.md`, `memory/proposals/*`, `context-packs/*`, or
`.local/*`; those reports are rejected as memory sources.

Before using an existing SQLite memory store for a handoff, you can audit active
facts without mutating the database:

```bash
oaf memory refine --read-only --root . --sqlite .local/memory.sqlite --format json
oaf memory refine --read-only --root . --sqlite .local/memory.sqlite --target-active-facts 200 --format json
oaf memory refine --read-only --root . --sqlite .local/memory.sqlite --target-active-facts 200 --min-confidence 0.5 --format summary
```

The report lists duplicate, conflicting, stale, supersession, lineage-residue,
and low-confidence candidates with safe fact IDs and source refs only. It does
not approve, reject, supersede, delete, call models, use network access, or
include memory source bodies. If refine candidates exist and `memory/profile.md`
exists, it reports the derived profile locator and hash for review without
exposing profile text.
If the SQLite file is missing or has no OAF memory tables yet, the command still
returns JSON with `state: "unavailable"` and zero candidates.
When `--target-active-facts` is provided, the same read-only report includes a
`budgetPlan` that ranks existing candidates by review priority and estimates
whether the target can be reached without inventing facts or mutating memory.

For a smaller impact report:

```bash
oaf token-saver
```

For the expanded command:

```bash
oaf measure context-pack \
  --read-only \
  --from codex \
  --root . \
  --objective "Prepare handoff" \
  --step "impact brief" \
  --target codex \
  --changed-from-git \
  --format json
```

Use `--format summary` when you want a compact operator report with the same
read-only measurement, MCP readback, timing, and safeguard fields.

Use `--changed path/to/file.ts` when you want to avoid git detection or review
exact paths manually.

## Skill Catalog Preflight

Use this when you want to see which local OAF skills a coding agent may be
asked to load before you start a handoff:

```bash
oaf skill catalog --read-only --root . --format json
```

When a trigger matches one skill, ask for its local read plan before loading
instructions:

```bash
oaf skill load-plan --read-only --root . --id skill:oaf-memory --format json
oaf skill load-plan --read-only --root . --id skill:oaf-memory --format summary
```

The same summary is also available through the read-only MCP resource catalog:

```bash
oaf mcp resources --read-only \
  --uri oaf://workspace/ws_local/skills/catalog \
  --format json
```

Per-skill load plans are available after the catalog validates:

```bash
oaf mcp resources --read-only \
  --uri oaf://workspace/ws_local/skills/oaf-memory/load-plan \
  --format json
```

To inspect the full read-only MCP surface without reading resource bodies:

```bash
oaf mcp inspect --read-only --root . --format summary
```

Use `--format summary` for a compact operator report. The inspect report groups
listed MCP resources and server tools by context tier, then the catalog
validates workspace skill manifests and reports descriptions, side-effect
classes, tool IDs, per-skill activation readiness, manifest fingerprints, and
catalog/report fingerprints.
It does not include
raw skill text, expose absolute filesystem paths, grant tool authority, start an
MCP server, call models, use network access, or write local files. A manifest can
set `advertise: false` to keep a skill loadable through JSON/MCP metadata while
omitting it from the compact human skill menu.

`oaf context handoff --read-only` includes the same safe catalog summary when a
workspace `skills/` directory is present, plus the `catalogSkills` command for
full local inspection.

The JSON handoff report also includes ordered `handoffParts` entries so clients
can render the launch instruction, context-pack resource, use-plan resource, and
read-only safeguards without parsing launch text.

## Pinned Local Artifact Path

Use this only when you want a checked local artifact under `context-packs/` that
another harness can receive without retyping the objective and step.

```bash
npm run oaf -- context pack \
  --from codex \
  --root . \
  --objective "Prepare handoff" \
  --step "select next agent context" \
  --target codex \
  --write \
  --pin \
  --out context-packs/CONTEXT_PACK.md \
  --format json

npm run oaf -- context receive \
  --read-only \
  --root . \
  --target codex \
  --format json
```

`context receive` reads the pinned registry, current pointer, and use plan. It
returns a compact receiver packet with versioned typed safe summary, recipient
proof, read-plan, and next-action message parts. Use `--format summary` for a
copyable operator preflight with the same state, proof, read counts, and report
fingerprint. It does not rebuild the pack, accept task text, write files, expose
raw Markdown bodies, or enable MCP write tools.
Use `oaf context retrieve <workspace-locator-or-sha256> --read-only --format summary`
to verify a required local read by hash without printing file content.

If `context receive` reports `blocked` or `review`, use its
`Create pinned context pack` next action as a template. Replace
`<reviewed-objective>` and `<reviewed-step>` with text you are comfortable
persisting in the local Markdown artifact, review the generated pack, then run
`context receive --read-only` again.

Generated files under `context-packs/` are ignored by default because their
Markdown can include visible objective and step text. Use
`git add -f context-packs/...` only after reviewing the artifact and deciding
to share it.

## Harness-Specific Use

Codex:

```bash
oaf context handoff --read-only --from codex --root . --objective "Prepare handoff" --step "select next agent context" --target codex --changed-from-git --format json
npm run oaf -- harness setup status --client codex --dry-run --format json
npm run oaf -- harness setup plan --client codex --server oaf --dry-run --format json
npm run oaf -- harness setup uninstall --client codex --server oaf --dry-run --format json
```

Cursor:

```bash
oaf context handoff --read-only --from codex,cursor --root . --objective "Prepare handoff" --step "select next agent context" --target cursor --changed-from-git --format json
```

Claude Code:

```bash
oaf context handoff --read-only --from codex,claude-code --root . --objective "Prepare handoff" --step "select next agent context" --target claude-code --changed-from-git --format json
npm run oaf -- harness setup status --client claude-code --dry-run --format json
npm run oaf -- harness setup plan --client claude-code --server oaf --dry-run --format json
npm run oaf -- harness setup uninstall --client claude-code --server oaf --dry-run --format json
```

Cursor setup preview:

```bash
npm run oaf -- harness setup plan --client cursor --server oaf --dry-run --format json
```

Claude Code setup preview:

```bash
npm run oaf -- harness setup plan --client claude-code --server oaf --dry-run --format json
```

Read-only hook receipt preview:

```bash
npm run oaf -- connect codex --dry-run --format json
npm run oaf -- connect claude-code --dry-run --format json
npm run oaf -- hook install --agent codex --dry-run --format json
npm run oaf -- hook install --agent claude-code --dry-run --format json
npm run oaf -- hook uninstall --agent codex --dry-run --format json
```

The `harness setup` and `hook install` commands are dry-run previews. They
report redacted config operations but do not edit `.codex`, `.cursor`, Claude
Code, or other home configuration files. `oaf connect <agent> --yes` is the
narrow opt-in writer for Codex and Claude Code only: it writes the fixed
read-only MCP and hook entries, creates backups, and reports a receipt.
`oaf disconnect <agent> --yes` removes those OAF-owned entries. Each preview
also includes a generated
`manualConfigSnippet` or `manualHookSnippet` for the selected harness. It is
derived from OAF's fixed read-only MCP and hook commands, not from your existing
config body.

Generated Context Pack Markdown now includes **Bridge Commands** for pinning a
local artifact, receiving it, starting the read-only MCP bridge, reading the
registry and use-plan resources, and previewing harness setup. Treat the pin
command as an explicit local write to `context-packs/`; the receive and MCP
commands remain read-only.

## What To Check Before Trusting A Pack

Treat a pack as usable only when the report proves:

- `state` or utility status is `ready`;
- changed locators are represented or explicitly called out for review;
- `toolsExposed` is `0`;
- `localFilesWritten` is `0` for read-only paths;
- `networkCalls` is `0`;
- `modelCalls` is `0`;
- `externalAdaptersEnabled` is `0`;
- source bodies, diff bodies, raw task text, provider URLs, credentials, and
  absolute local paths are not present.

If any check is missing, use the report as a diagnostic, not as a launch-ready
handoff.

## Troubleshooting

If the browser fails with a 401 or bootstrap message, create the local owner and
sign in before running protected actions.

If a context-pack action fails after recent code changes, restart `npm run dev`
and retry from <http://127.0.0.1:4310/context-pack>.

If git detection reports unavailable, pass explicit changed files:

```bash
--changed apps/web/app.js --changed services/control-api/src/server.mjs
```

If a pinned handoff is stale or blocked, rebuild and pin it from the current
checkout, then run `context receive --read-only` again.

## Unsupported Today

OAF does not yet provide production authentication, automatic transcript import,
automatic active memory creation, real harness config writes, hosted model
providers, external connectors, browser automation, write-capable MCP tools,
graph databases, vector databases, external publishing, or signed public
distribution.

Those features require separate tasks, policy review, and release evidence
before they can be claimed.
