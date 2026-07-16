import path from 'node:path';
import process from 'node:process';

function helpCommandName() {
  if (process.env.npm_lifecycle_event === 'recall') return 'recall';
  return path.basename(process.argv[1] ?? '') === 'recall' ? 'recall' : 'oaf';
}

function renderHelpText(text) {
  const command = helpCommandName();
  if (command === 'oaf') return text;
  return text
    .replace(
      /\boaf (?=(status|setup|verify|doctor|connect|disconnect|task|demo|serve|check|eval|manifest|map|semantic|handoff|token-saver|context|graph|loop|skill|measure|benchmark|bench|memory|mcp|harness|hook|version)\b)/g,
      `${command} `
    );
}

export function printHelp(topic, subtopic) {
  const topicHelp = helpTopic(topic, subtopic);
  if (topicHelp) {
    console.log(renderHelpText(topicHelp));
    return;
  }

  console.log(renderHelpText(`Memory Recall CLI

Usage:
  oaf status
  oaf setup
  oaf verify
  oaf doctor
  oaf connect codex --dry-run --format json
  oaf disconnect codex --dry-run --format json
  oaf task <OAF-ID>
  oaf demo [objective]
  oaf demo memory-loop --root . --format json
  oaf serve
  oaf check
  oaf eval
  oaf manifest
  oaf map --root . --sqlite .local/memory.sqlite --format summary
  oaf semantic plan --harness codex --root . --dry-run
  oaf semantic task --harness codex --root .
  oaf semantic import --input semantic-result.json --root . --sqlite .local/memory.sqlite
  oaf semantic run --provider gemini --allow-network --root . --sqlite .local/memory.sqlite
  oaf handoff
  oaf handoff --read-only --from codex --root . --objective "Ship safely" --step "handoff" --target codex --changed-from-git --format summary
  oaf token-saver
  oaf token-saver --all-shards
  oaf token-saver --read-only --root . --from codex --objective "Ship safely" --step "impact brief" --target codex --changed-from-git --format summary
  oaf context --request request.json --records records.json
  oaf context profile --records memory-export.json --objective "Ship safely" --step "select compact memory" --token-budget 4096 --format json
  oaf context scan --from codex --root . --dry-run
  oaf context preview --from codex --root . --objective "Ship safely" --step "select context" --include-file notes/handoff.md --dry-run
  oaf context pack --from codex --root . --objective "Ship safely" --step "handoff" --target codex --include-file notes/handoff.md --changed src/auth.ts --changed-from-git --dry-run --format markdown
  oaf context pack --from codex --root . --objective "Ship safely" --step "handoff" --target codex --write --out context-packs/CONTEXT_PACK.md --use-out context-packs/CONTEXT_PACK.use.json --format json
  oaf context pack --from codex --root . --objective "Ship safely" --step "handoff" --target codex --write --pin --out context-packs/CONTEXT_PACK.md --format json
  oaf context handoff --read-only --from codex --root . --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --memory-config oaf.memory.json --format json
  oaf context handoff --read-only --from codex --root . --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --format summary
  oaf context receive --read-only --root . --target codex --format json
  oaf context receive --read-only --root . --target codex --format summary
  oaf context retrieve workspace://AGENTS.md --read-only --root . --format json
  oaf context retrieve workspace://AGENTS.md --read-only --root . --format summary
  oaf context registry status --read-only --format json
  oaf context graph preview --root . --query "approve token reset" --trace runAuthWorkflow --changed src/auth.ts --changed-from-git --dry-run --format summary
  oaf graph stats --root . --format summary
  oaf graph search --root . --query "route registration hooks" --format summary
  oaf graph trace --root . --symbol runAuthWorkflow --direction outbound --format summary
  oaf graph impact --root . --changed src/auth.ts --format summary
  oaf graph index --status --root . --format summary
  oaf graph index --write --root . --format json
  oaf graph index --refresh --watch --root . --format summary
  oaf loop plan --read-only --root . --objective "Ship safely" --stop-condition "focused tests pass" --validation "node --test tests/web-shell.test.mjs" --format json
  oaf loop observe --root . --plan loop-plan.json --execute-commands --format json
  oaf loop verify --root . --plan loop-plan.json --worktree ../isolated-worktree --sqlite .local/memory.sqlite --execute-commands --format json
  oaf loop run --root . --plan loop-plan.json --worktree ../isolated-worktree --sqlite .local/memory.sqlite --execute-commands --format json
  oaf loop schedule --read-only --root . --plan loop-plan.json --kind triage --cadence manual --format json
  oaf skill catalog --read-only --root . --format json
  oaf skill load-plan --read-only --root . --id skill:oaf-memory --format json
  oaf skill load-plan --read-only --root . --id skill:oaf-memory --format summary
  oaf measure savings --read-only --root . --objective "Ship safely" --step "measure savings" --format json
  oaf measure savings --read-only --root . --objective "Ship safely" --step "measure savings" --format summary
  oaf measure context-pack --read-only --root . --from codex --objective "Ship safely" --step "impact brief" --target codex --changed src/auth.ts --format json
  oaf measure context-pack --read-only --root . --from codex --objective "Ship safely" --step "impact brief" --target codex --changed src/auth.ts --format summary
  oaf benchmark truth-floor --suite benchmark-truth-floor --dataset evals/benchmark-truth-floor/cases.v1.json --format json
  oaf bench sufficiency --read-only --root . --format json
  oaf bench temporal --read-only --root . --format json
  oaf bench session --read-only --root . --format json
  oaf bench realqa --read-only --root . --format json
  oaf bench locomo --read-only --root . --dataset evals/locomo/smoke.v1.json --format json
  oaf memory profile --records memory-export.json --root . --dry-run --format json
  oaf memory remember --root . --sqlite .local/memory.sqlite --subject auth --predicate token_expiry --object "15 minutes" --supersedes-subject auth --supersedes-predicate token_expiry --source workspace://DECISIONS.md --format json
  oaf memory remember --batch facts.json --root . --sqlite .local/memory.sqlite --format json
  oaf memory ingest --root . --sqlite .local/memory.sqlite --format json
  oaf memory review --root . --sqlite .local/memory.sqlite --format summary
  oaf memory approve mpq_status --root . --sqlite .local/memory.sqlite --format json
  oaf memory approve --all-from workspace://PROJECT_STATUS.json --root . --sqlite .local/memory.sqlite --format json
  oaf memory approve --all --root . --sqlite .local/memory.sqlite --format json
  oaf memory reject mpq_status --root . --sqlite .local/memory.sqlite --format json
  oaf memory review approve --root . --sqlite .local/memory.sqlite --proposal mpq_status --format json
  oaf memory refine --read-only --root . --sqlite .local/memory.sqlite --target-active-facts 200 --format json
  oaf memory refine --read-only --root . --sqlite .local/memory.sqlite --target-active-facts 200 --min-confidence 0.5 --format summary
  oaf memory proposals --records memory-export.json --root . --dry-run --format json
  oaf memory proposals --from memoryPaths --config oaf.memory.json --root . --dry-run --format json
  oaf memory sgrep "context manifest" --records memory-export.json --workspace ws_local --dry-run --format json
  oaf memory fact add --sqlite .local/memory.sqlite --workspace ws_local --scope workspace --subject project:memory-recall --predicate release_status --object release-candidate --text "Memory Recall release status is release-candidate." --source workspace://memory/status.md --proposal mpq_status --episode-id mep_status --episode-source workspace://memory/status.md --episode-summary "Reviewed status note." --format json
  oaf memory fact get --sqlite .local/memory.sqlite --workspace ws_local --scope workspace --subject project:memory-recall --predicate release_status --at 2026-06-26T00:00:00.000Z --format json
  oaf memory fact history --sqlite .local/memory.sqlite --workspace ws_local --scope workspace --subject project:memory-recall --predicate release_status --format json
  oaf memory search "release" --sqlite .local/memory.sqlite --workspace ws_local --scope workspace --format json
  oaf memory path --root . --sqlite .local/memory.sqlite --workspace ws_local --scope workspace --from project:memory-recall --to temporal-memory --max-hops 6 --format json
  oaf memory explain --root . --sqlite .local/memory.sqlite --workspace ws_local --scope workspace --entity auth --depth 1 --format json
  oaf mcp inspect --read-only --root . --format json
  oaf mcp resources --read-only --workspace ws_local --format json
  oaf mcp resources --read-only --uri oaf://workspace/ws_local/skills/catalog --format json
  oaf mcp resources --read-only --uri oaf://workspace/ws_local/tools/catalog --format summary
  oaf mcp resources --read-only --memory-refine --uri oaf://workspace/ws_local/memory/refine --format summary
  oaf mcp resources --read-only --context-pack --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --changed-from-git --uri oaf://workspace/ws_local/context-pack/current --format json
  oaf mcp resources --read-only --context-pack-use context-packs/CONTEXT_PACK.use.json --uri oaf://workspace/ws_local/context-pack/use-plan/current --format json
  oaf mcp resources --read-only --context-pack-registry --uri oaf://workspace/ws_local/context-pack/registry/current --format json
  oaf mcp smoke context-pack --read-only --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --changed-from-git --format json
  oaf mcp resources --read-only --stdio
  oaf mcp server --read-only --root . --stdio
  oaf mcp stats --read-only --root . --format json
  oaf mcp install --client claude-code --dry-run --format json
  oaf harness setup status --client codex --dry-run --format json
  oaf harness setup plan --client cursor --server oaf --dry-run --format json
  oaf harness setup uninstall --client cursor --server oaf --dry-run --format json
  oaf hook install --agent codex --dry-run --format json
  oaf hook uninstall --agent codex --dry-run --format json
  oaf hook context --read-only --format text
  oaf version

Start with oaf status; if it says Next task: none, run the First safe handoff command it prints.
Run oaf task only when npm run status names a next task.
oaf setup creates only local state in the current repository; it does not scan source files. Use oaf map for the first explicit read-only scan and oaf harness setup plan/status for dry-run wiring previews.
The default bootstrap is local-only and enables no external writes.`));
}

const TOPIC_HELP = new Map([
    ['setup', `Memory Recall CLI: setup

Usage:
  oaf setup

Creates only local Recall state in the current repository. It does not scan
source files, run Recall Map, configure MCP clients, install harness servers,
activate memory, or enable external writes.

Run the explicit first read-only map next:
  oaf map --root . --sqlite .local/memory.sqlite --format summary

Use harness setup for client wiring previews:
  oaf harness setup status --client codex --dry-run --format json
  oaf harness setup plan --client codex --server oaf --dry-run --format json`],
    ['map', `Memory Recall CLI: map

Usage:
  oaf map --root . --sqlite .local/memory.sqlite --format summary
  oaf map --root . --changed src/auth.ts --query "token reset" --format json
  oaf map --root . --changed-from-git --format markdown

Options:
  --root <path>                       Target repository; defaults to the current directory.
  --sqlite <workspace-relative path>  Local SQLite memory store; defaults to .local/memory.sqlite.
  --changed <path>                    Add a reviewed changed workspace path; repeatable.
  --changed-from-git                  Detect changed paths with local git only.
  --query <text>                      Search the bounded JS/TS source graph.
  --format <json|summary|markdown>    Emit the full safe report or a compact rendering.

Builds a bounded local repository map from the implemented JS/TS static graph
and the governed local SQLite memory store. It does not write files, call
models, use network access, enable external adapters, or expose raw source
bodies.`],
    ['semantic', `Memory Recall CLI: semantic

Usage:
  oaf semantic plan --harness codex --root . --dry-run
  oaf semantic task --harness codex --root .
  oaf semantic import --input semantic-result.json --root . --sqlite .local/memory.sqlite
  oaf semantic run --provider gemini --allow-network --root . --sqlite .local/memory.sqlite
  oaf semantic run --provider openai-compatible --endpoint https://api.example.test/v1/chat/completions --model model-id --api-key-env MODEL_API_KEY --allow-network --root .

Plan emits a body-free JSON report and task emits only the bounded raw harness
task. Import reads one workspace-relative JSON result. Run performs exactly one
explicitly consented model request. Import and run normalize untrusted results
into pending SQLite proposals only; neither command creates active memory.`],
    ['connect', `Memory Recall CLI: connect

Usage:
  oaf connect codex --dry-run --format json
  oaf connect codex --yes --format json
  oaf disconnect codex --dry-run --format json

Previews or applies local harness client configuration through the governed
connection wrapper. It is dry-run by default. --yes writes only the local
harness client config for the selected agent; it does not enable external
writes, grant authority, activate memory, or call models.`],
    ['disconnect', `Memory Recall CLI: disconnect

Usage:
  oaf disconnect codex --dry-run --format json
  oaf disconnect codex --yes --format json

Previews or applies removal of local OAF harness client configuration through
the governed connection wrapper. It is dry-run by default. --yes removes only
matching local harness config entries; it does not touch project state, memory,
models, or external services.`],
    ['harness setup', `Memory Recall CLI: harness setup

Usage:
  oaf harness setup status --client codex --dry-run --format json
  oaf harness setup plan --client cursor --server oaf --dry-run --format json
  oaf harness setup uninstall --client cursor --server oaf --dry-run --format json

Builds dry-run reports for local harness client wiring. This command is preview
only: it requires --dry-run, does not mutate home config, does not write local
files, does not grant authority, and does not enable external writes.`],
    ['context', `Memory Recall CLI: context

Usage:
  oaf handoff
  oaf context scan --from codex --root . --dry-run
  oaf context preview --from codex --root . --objective "Ship safely" --step "select context" --include-file notes/handoff.md --dry-run
  oaf context pack --from codex --root . --objective "Ship safely" --step "handoff" --target codex --include-file notes/handoff.md --changed src/auth.ts --dry-run --format json
  oaf context handoff --read-only --from codex --root . --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --format json
  oaf context handoff --read-only --from codex --root . --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --format summary
  oaf context receive --read-only --root . --target codex --format json
  oaf context receive --read-only --root . --target codex --format summary
  oaf context retrieve workspace://AGENTS.md --read-only --root . --format summary
  oaf context graph preview --root . --query "approve token reset" --trace runAuthWorkflow --changed src/auth.ts --dry-run --format summary
  oaf context registry status --read-only --format json

Context commands select local handoff context, preview harness inputs, and read
pinned context-pack state. Graph preview is dry-run only. Read-only commands do
not write files, call models, use network access, or expose raw source bodies.
Retrieve summary verifies locator/hash metadata without printing file content.`],
    ['graph', `Memory Recall CLI: graph

Usage:
  oaf graph stats --root . --format summary
  oaf graph search --root . --query "route registration hooks" --format summary
  oaf graph trace --root . --symbol runAuthWorkflow --direction outbound --format summary
  oaf graph impact --root . --changed src/auth.ts --format summary
  oaf graph impact --root . --changed-from-git --format json
  oaf graph index --status --root . --format summary
  oaf graph index --write --root . --format json
  oaf graph index --refresh --root . --format json
  oaf graph index --refresh --watch --root . --format summary

Graph commands build a bounded local JS/TS source graph and return locator-only
stats, search, trace, or changed-file impact reports. Index writes are explicit.
The index stores structural metadata under .local/source-graph by default and
never stores raw source bodies. MCP reads the index but never builds or refreshes it.
No graph command makes model or network calls.`],
    ['context handoff', `Memory Recall CLI: context handoff

Usage:
  oaf handoff
  oaf context handoff --read-only --from codex --root . --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --format json
  oaf context handoff --read-only --from codex --root . --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --format summary

Options:
  --from <codex[,cursor,claude-code]>  Source harness families to inspect.
  --target <codex|cursor|claude-code|a2a|generic>  Receiver harness.
  --include-file <path>                Add reviewed workspace-relative files.
  --changed <path>                     Add reviewed changed files.
  --changed-from-git                   Detect changed files with local git.
  --memory-config <path>               Preflight selected memory source paths.
  --format json|summary                Emit the validated report or compact operator summary.

Builds a read-only local agent handoff with context-pack proof, MCP readback,
harness setup dry-run status, and zero-tool MCP proof. It requires --read-only
and does not write files, import harness history, call models, use network
access, or expose raw source bodies.`],
    ['handoff', `Memory Recall CLI: handoff

Usage:
  oaf handoff
  oaf handoff --read-only --from codex --root . --objective "Ship safely" --step "handoff" --target codex --changed-from-git --format summary
  oaf context handoff --read-only --from codex --root . --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --format json

Runs the read-only context handoff flow. With no flags it defaults to a compact
Codex summary for the current repository and local git changes. It does not
write files, import harness history, call models, use network access, enable
external adapters, create active memory, or expose raw source bodies.`],
    ['token-saver', `Memory Recall CLI: token-saver

Usage:
  oaf token-saver
  oaf token-saver --all-shards
  oaf token-saver --read-only --root . --from codex --objective "Ship safely" --step "impact brief" --target codex --changed-from-git --format summary
  oaf measure context-pack --read-only --root . --from codex --objective "Ship safely" --step "impact brief" --target codex --changed src/auth.ts --format json

Runs the read-only context-pack measurement flow. With no flags it measures the
current repository and local git changes. It does not write files, call models,
use network access, enable external adapters, include raw source bodies, or
claim provider billing-token savings.`],
    ['context receive', `Memory Recall CLI: context receive

Usage:
  oaf context receive --read-only --root . --target codex --format json
  oaf context receive --read-only --root . --target codex --format summary

Reads the pinned local context-pack registry, current pointer, and use plan
without rebuilding or writing files. JSON returns the versioned receiver packet;
summary prints state, recipient proof, packet parts, required reads, and report
fingerprint. It rejects task text, write flags, MCP stdio mode, raw Markdown
bodies, source bodies, credentials, provider URLs, and absolute local paths.`],
    ['context registry', `Memory Recall CLI: context registry

Usage:
  oaf context registry status --read-only --format json

Reads the pinned local context-pack registry and verifies the current pointer,
artifact hashes, and source hashes. It requires --read-only and does not rebuild
packs, write artifacts, call models, use network access, or expose raw source
bodies.`],
    ['skill', `Memory Recall CLI: skill

Usage:
  oaf skill catalog --read-only --root . --format json
  oaf skill catalog --read-only --root . --format summary
  oaf skill load-plan --read-only --root . --id skill:oaf-memory --format json
  oaf skill load-plan --read-only --root . --id skill:oaf-memory --format summary

Skill commands inspect local OAF skill manifests. They do not grant tool
authority or load raw skill text into the report.`],
    ['skill catalog', `Memory Recall CLI: skill catalog

Usage:
  oaf skill catalog --read-only --root . --format json
  oaf skill catalog --read-only --root . --format summary

Reports side-effect classes, tool IDs, manifest fingerprints, and
catalog/report fingerprints for workspace skills. It requires --read-only and
does not include raw skill text, expose absolute filesystem paths, grant tool
authority, start MCP stdio, call models, use network access, or write local
files.`],
    ['skill load-plan', `Memory Recall CLI: skill load-plan

Usage:
  oaf skill load-plan --read-only --root . --id skill:oaf-memory --format json
  oaf skill load-plan --read-only --root . --id skill:oaf-memory --format summary

Returns the ordered local reads for one skill: manifest, SKILL.md, and declared
references. It requires --read-only and does not include raw skill text, grant
tool authority, start MCP stdio, call models, use network access, or write local
files.`],
    ['measure', `Memory Recall CLI: measure

Usage:
  oaf measure savings --read-only --root . --objective "Ship safely" --step "measure savings" --format json
  oaf measure context-pack --read-only --root . --from codex --objective "Ship safely" --step "impact brief" --target codex --changed src/auth.ts --format json

Measure commands emit local evidence about context delivery. They do not claim
provider billing savings, call models, use network access, or perform external
writes.`],
    ['measure context-pack', `Memory Recall CLI: measure context-pack

Usage:
  oaf measure context-pack --read-only --root . --from codex --objective "Ship safely" --step "impact brief" --target codex --changed src/auth.ts --format json
  oaf measure context-pack --read-only --root . --from codex --objective "Ship safely" --step "impact brief" --target codex --changed-from-git --format summary

Measures the same read-only context-pack path used for handoff: selected and
delivered token estimates, changed-file coverage, MCP readback, timings, and
safeguards. It requires --read-only and does not include raw source bodies,
call models, use network access, or write local files.`],
    ['mcp', `Memory Recall CLI: mcp

Usage:
  oaf mcp inspect --read-only --root . --format json
  oaf mcp inspect --read-only --root . --format summary
  oaf mcp resources --read-only --workspace ws_local --format json
  oaf mcp resources --read-only --uri oaf://workspace/ws_local/skills/catalog --format json
  oaf mcp resources --read-only --uri oaf://workspace/ws_local/tools/catalog --format summary
  oaf mcp resources --read-only --memory-refine --uri oaf://workspace/ws_local/memory/refine --format summary
  oaf mcp resources --read-only --context-pack --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --format json
  oaf mcp server --read-only --root . --stdio
  oaf mcp stats --read-only --root . --format json
  oaf mcp smoke context-pack --read-only --objective "Ship safely" --step "handoff" --target codex --changed src/auth.ts --format json
  oaf mcp install --client claude-code --dry-run --format json

MCP commands inspect or expose local read-only resources, run the stdio bridge,
preview install plans, or report delivery stats. Resource summaries require
--uri and do not dump full resource bodies. Resource/server paths require
--read-only; install remains dry-run unless explicitly confirmed by the install
flow.`],
    ['memory refine', `Memory Recall CLI: memory refine

Usage:
  oaf memory refine --read-only --root . --sqlite .local/memory.sqlite --format json
  oaf memory refine --read-only --root . --sqlite .local/memory.sqlite --target-active-facts 200 --format json
  oaf memory refine --read-only --root . --sqlite .local/memory.sqlite --target-active-facts 200 --min-confidence 0.5 --format summary

Scans governed local memory for duplicate, conflicting, stale, and lineage
residue candidates without applying changes. It also reports ACTIVE facts below
--min-confidence, which defaults to 0.5. --target-active-facts adds a read-only
budget preflight from existing candidates only. Summary output prints counts,
budget status, safeguards, and fingerprint only. It requires
--read-only and does not create active memory, write proposals, delete facts,
call models, use network access, or expose raw private bodies. Missing or stale
SQLite memory schemas return state: "unavailable" with zero candidates.`]
]);

function helpTopic(topic, subtopic) {
  const key = [topic, subtopic].filter(Boolean).join(' ');
  return TOPIC_HELP.get(key) ?? TOPIC_HELP.get(topic);
}
