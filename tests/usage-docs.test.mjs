import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function read(path) {
  return readFileSync(path, 'utf8');
}

test('public usage docs avoid stale task and missing context-file examples', () => {
  assert.equal(existsSync('docs/usage/local-agent-handoff.md'), true);
  const docs = [
    read('ASSIGN_TO_AGENT.md'),
    read('README.md'),
    read('LOCAL_DEVELOPMENT.md'),
    read('docs/START_HERE.md'),
    read('docs/implementation/OAF-031-context-intake-preview-note.md'),
    read('docs/usage/local-agent-handoff.md')
  ].join('\n');

  assert.equal(docs.includes('docs/context.md'), false);
  assert.equal(docs.includes('oaf task OAF-004'), false);
  assert.match(docs, /npm run task -- <OAF-ID>` only when status names a next task/);
  assert.match(docs, /docs\/usage\/local-agent-handoff\.md/);
  assert.match(docs, /copy and run/);
  assert.match(docs, /mcp install --client claude-code --dry-run --format json/);
  assert.match(docs, /npm run oaf -- memory refine --read-only --root \. --sqlite \.local\/memory\.sqlite --target-active-facts 200 --format json/);
  assert.match(docs, /npm run oaf -- context handoff --read-only --from codex --root \. --objective "Prepare handoff" --step "select next agent context" --target codex --changed apps\/web\/app\.js --format json/);
  assert.match(docs, /--apply --confirm <fingerprint>/);
  assert.match(docs, /does\s+not import harness history, enable write tools, call cloud\/model APIs, or claim\s+provider billing-token savings/);

  const localIgnore = existsSync('.gitignore') ? read('.gitignore') : read('.npmignore');
  assert.match(localIgnore, /^context-packs\/$/m);
});

test('local handoff guide documents read-only Codex Cursor and Claude paths', () => {
  const guide = read('docs/usage/local-agent-handoff.md');

  assert.match(guide, /target codex --changed-from-git --format json/);
  assert.match(guide, /First run `npm run status`; when it reports `Next task: none`, use the\n`First safe handoff` command it prints or continue below\./);
  assert.match(guide, /npm ci --ignore-scripts --no-audit --no-fund\nnpm run bootstrap\nnpm run doctor\nnpm run verify:handoff\nnpm run status\nnpm run dev/);
  assert.match(guide, /Create a first local handoff/);
  assert.match(guide, /Inputs to review/);
  assert.match(guide, /Practical handoff/);
  assert.match(guide, /Memory preflight\s+sources \(optional\)/);
  assert.match(guide, /--from codex,cursor .* --target cursor --changed-from-git --format json/);
  assert.match(guide, /--from codex,claude-code .* --target claude-code --changed-from-git --format json/);
  assert.match(guide, /Use `--target a2a` when the next worker is another agent service/);
  assert.match(guide, /coordinator-selected embedded context with versioned typed safe parts/);
  assert.match(guide, /does not create shared agent state,\s+write tools, active memory, raw source bodies, or external credentials/);
  assert.match(guide, /harness setup plan --client cursor --server oaf --dry-run --format json/);
  assert.match(guide, /harness setup status --client codex --dry-run --format json/);
  assert.match(guide, /harness setup uninstall --client codex --server oaf --dry-run --format json/);
  assert.match(guide, /harness setup plan --client claude-code --server oaf --dry-run --format json/);
  assert.match(guide, /harness setup uninstall --client claude-code --server oaf --dry-run --format json/);
  assert.match(guide, /hook install --agent codex --dry-run --format json/);
  assert.match(guide, /connect codex --dry-run --format json/);
  assert.match(guide, /git add -f context-packs\/\.\.\./);
  assert.match(guide, /writes context-pack files only when you click \*\*Pin locally\*\*/);
  assert.match(guide, /connect <agent> --yes/);
  assert.match(guide, /creates backups/);
  assert.match(guide, /externalAdaptersEnabled/);
  assert.match(guide, /does not yet provide production authentication/);
});

test('local handoff guide documents read-only skill catalog preflight', () => {
  const guide = read('docs/usage/local-agent-handoff.md');

  assert.match(guide, /Skill Catalog Preflight/);
  assert.match(guide, /oaf skill catalog --read-only --root \. --format json/);
  assert.match(guide, /oaf:\/\/workspace\/ws_local\/skills\/catalog/);
  assert.match(guide, /oaf mcp inspect --read-only --root \. --format summary/);
  assert.match(guide, /--format summary/);
  assert.match(guide, /listed MCP resources and server tools by context tier/);
  assert.match(guide, /descriptions, side-effect\s+classes, tool\s+IDs, per-skill\s+activation readiness, manifest fingerprints, and\s+catalog\/report fingerprints/);
  assert.match(guide, /does not include\s+raw skill text, expose absolute filesystem paths, grant tool authority/);
  assert.match(guide, /call models, use network access, or write local files/);
});

test('protocol bridge docs separate pending A2A bridge from receiver packets', () => {
  const guide = read('docs/architecture/protocol-bridges.md');

  assert.match(guide, /A2A remains pending as a full protocol bridge/);
  assert.match(guide, /`--target a2a`\nhandoff path is only a read-only receiver packet/);
  assert.match(guide, /versioned typed safe parts, required local reads, and zero write\ntools/);
});

test('native provider docs match shipped graph candidate source boundary', () => {
  const guide = read('docs/architecture/native-providers.md');
  const catalog = JSON.parse(read('providers/native/catalog.json'));
  const graphProvider = catalog.providers.find((provider) => provider.id === 'provider:native:context-candidate:graph');

  assert.equal(graphProvider?.enabledByDefault, true);
  assert.match(guide, /`native\.context-candidate\.graph` \| on \| Locator-only candidate source over the derived JS\/TS source graph/);
  assert.match(guide, /native graph source\nis available now as a locator-only wrapper over the derived JS\/TS source graph/);
  assert.doesNotMatch(guide, /Vector, graph, temporal, preference, and episode source kinds remain declared/);
});

test('issue tracker docs use supported gh PR queue fields', () => {
  const guide = read('docs/agents/issue-tracker.md');

  assert.match(guide, /gh pr list --state open --json number,title,author,isDraft,mergeStateStatus,mergeable,statusCheckRollup,labels,headRefName,updatedAt,url/);
  assert.match(guide, /When open issues are empty, inspect open PRs before inventing backlog work/);
  assert.match(guide, /compare `gh pr diff <number> --name-only` with the active branch \(`git diff --name-only origin\/main\.\.\.HEAD`\), staged \(`git diff --cached --name-only`\), and unstaged \(`git diff --name-only`\) file lists/);
  assert.match(guide, /For status-only queue checks, stop after listing issues\/PRs and reading check\s+state; do not comment, label, close, merge, or publish without an explicit user\s+request/);
  assert.doesNotMatch(guide, /authorAssociation/);
});

test('troubleshooting documents read-only hook mcp rollback and benchmark fallbacks', () => {
  const guide = read('TROUBLESHOOTING.md');

  assert.match(guide, /hook context --read-only --format text/);
  assert.match(guide, /mcp resources --read-only --stdio/);
  assert.match(guide, /context registry status --read-only --format json/);
  assert.match(guide, /harness setup uninstall --client codex --server oaf --dry-run --format json/);
  assert.match(guide, /hook uninstall --agent codex --dry-run --format json/);
  assert.match(guide, /disconnect codex --dry-run --format json/);
  assert.match(guide, /benchmark truth-floor/);
  assert.match(guide, /eval:context-recall/);
});
