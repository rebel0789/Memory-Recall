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
  assert.match(docs, /--apply --confirm <fingerprint>/);
  assert.match(docs, /does\s+not import harness history, enable write tools, call cloud\/model APIs, or claim\s+provider billing-token savings/);

  const localIgnore = existsSync('.gitignore') ? read('.gitignore') : read('.npmignore');
  assert.match(localIgnore, /^context-packs\/$/m);
});

test('local handoff guide documents read-only Codex Cursor and Claude paths', () => {
  const guide = read('docs/usage/local-agent-handoff.md');

  assert.match(guide, /target codex --changed-from-git --format json/);
  assert.match(guide, /Create a first local handoff/);
  assert.match(guide, /Inputs to review/);
  assert.match(guide, /Practical handoff/);
  assert.match(guide, /Memory preflight\s+sources \(optional\)/);
  assert.match(guide, /--from codex,cursor .* --target cursor --changed-from-git --format json/);
  assert.match(guide, /--from codex,claude-code .* --target claude-code --changed-from-git --format json/);
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
