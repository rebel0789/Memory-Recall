# Local Agent Handoff Guide

This guide is the shortest path for using Open Agent Fabric today. It is for a
developer who wants to hand the current repository to another local coding
agent with less noise, explicit changed-file context, and proof that OAF did
not leak raw source bodies or perform hidden writes.

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
npm ci --ignore-scripts --no-audit --no-fund
npm run bootstrap
npm run verify:handoff
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

```bash
npm --silent run oaf -- context handoff \
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

If you want to review possible durable memories from files you selected, add a
workspace-relative `--memory-config oaf.memory.json`. The config must name
explicit `memoryPaths`; the handoff report only returns counts, warning codes,
fingerprints, and the matching dry-run `memory proposals` command. It does not
create proposal Markdown, activate memory, import harness transcripts, or include
memory/source text in the report.

For a smaller impact report:

```bash
npm --silent run oaf -- measure context-pack \
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
does not rebuild the pack, accept task text, write files, expose raw Markdown
bodies, or enable MCP write tools.

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
npm --silent run oaf -- context handoff --read-only --from codex --root . --objective "Prepare handoff" --step "select next agent context" --target codex --changed-from-git --format json
```

Cursor:

```bash
npm --silent run oaf -- context handoff --read-only --from codex,cursor --root . --objective "Prepare handoff" --step "select next agent context" --target cursor --changed-from-git --format json
```

Claude Code:

```bash
npm --silent run oaf -- context handoff --read-only --from codex,claude-code --root . --objective "Prepare handoff" --step "select next agent context" --target claude-code --changed-from-git --format json
```

Cursor setup preview:

```bash
npm run oaf -- harness setup plan --client cursor --server oaf --dry-run --format json
```

Claude Code setup preview:

```bash
npm run oaf -- harness setup plan --client claude-code --server oaf --dry-run --format json
```

These setup commands are dry-run previews. They report redacted config
operations but do not edit `.codex`, `.cursor`, Claude Code, or other home
configuration files. Each report also includes a generated
`manualConfigSnippet` for the selected harness. It is derived from OAF's fixed
read-only MCP command, not from your existing config body.

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
