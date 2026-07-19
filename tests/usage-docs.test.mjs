import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function read(path) {
  return readFileSync(path, 'utf8');
}

test('polyglot leadership contract is approved and owns the native engine boundary', () => {
  const design = read('docs/superpowers/specs/2026-07-16-memory-recall-polyglot-leadership-design.md');
  const adr = read('docs/adr/0023-production-rust-code-intelligence-engine.md');

  assert.match(design, /\*\*Status:\*\* Approved for implementation/);
  assert.match(adr, /## Status\s+Accepted/);
  assert.match(adr, /Rust.*production code-intelligence engine/s);
  assert.match(adr, /Node\.js.*CLI.*Control API.*memory.*MCP.*web/s);
  assert.match(adr, /JSON Lines/);
  assert.match(adr, /derived local state/);
  assert.match(adr, /no local Rust toolchain/i);
});

test('README and status keep the patch candidate honest across the registry handoff', () => {
  const readme = read('README.md');
  const status = JSON.parse(read('PROJECT_STATUS.json'));
  const release = status.capabilities.find((capability) => capability.id === 'release.readiness');
  const web = status.capabilities.find((capability) => capability.id === 'bootstrap.web');

  assert.match(readme, /npm view memory-recall version/);
  assert.match(readme, /npm install -g memory-recall@latest\nrecall setup\nrecall map --root \. --sqlite \.local\/memory\.sqlite --format summary\nrecall handoff/);
  assert.match(readme, /Use the source checkout when testing changes that are not yet on the registry/);
  assert.doesNotMatch(readme, /npm still serves\s+1\.0\.5/);
  assert.match(release.limitations.join('\n'), /1\.1\.1 is the source patch candidate; use `npm view memory-recall version` to verify the current registry release/);
  assert.match(web.limitations.join('\n'), /confirm-gated proposal approval through the authenticated loopback API/);
});

test('semantic setup docs and status describe only the governed implemented path', () => {
  assert.equal(existsSync('docs/usage/semantic-setup.md'), true);
  const semantic = read('docs/usage/semantic-setup.md');
  const skill = `${read('skills/oaf-memory/SKILL.md')}\n${read('skills/oaf-memory/README.md')}`;
  const readme = read('README.md');
  const contract = read('docs/product/memory-recall-developer-first.md');
  const usageIndex = read('docs/usage/README.md');
  const status = JSON.parse(read('PROJECT_STATUS.json'));
  const semanticCapability = status.capabilities.find((capability) => capability.id === 'recall.semantic-setup');
  const directCapability = status.capabilities.find((capability) => capability.id === 'recall.semantic-api-run');

  for (const command of [
    'recall semantic plan --harness codex --root . --dry-run',
    'recall semantic task --harness codex --root .',
    'recall semantic import --input semantic-result.json --root . --sqlite .local/memory.sqlite',
    'recall semantic run --provider gemini --allow-network --root . --sqlite .local/memory.sqlite',
    'recall memory approve <mpq_id> --root . --sqlite .local/memory.sqlite --format json'
  ]) assert.match(semantic, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  assert.match(semantic, /does not invoke the\s+selected harness/i);
  assert.match(semantic, /at most 8 sources, 16 KiB per source, and 64 KiB total/);
  assert.match(semantic, /regular non-symlink file no larger than 256 KiB/);
  assert.match(semantic, /only selected documentation and configuration bodies\s+leave the machine/i);
  assert.match(semantic, /does\s+not persist the API key/i);
  assert.match(semantic, /outside the model gateway/i);
  assert.match(semantic, /bulk approval skips semantic setup proposals/i);
  assert.match(semantic, /rehashes every\s+cited source/i);
  assert.match(semantic, /rerun the semantic task/i);
  assert.match(semantic, /MCP remains read-only/i);
  assert.match(semantic, /no background sync/i);
  assert.match(semantic, /semantic setup v1 does\s+not scan or upload raw source-code files/i);
  assert.match(semantic, /usage counts.*not a provider billing guarantee/is);
  assert.match(semantic, /one request with no automatic retry/i);
  assert.doesNotMatch(`${semantic}\n${skill}`, /oaf ingest-docs|memory consolidate/);
  assert.match(usageIndex, /\[Semantic setup\]\(semantic-setup\.md\)/);
  assert.match(readme, /docs\/usage\/semantic-setup\.md/);
  assert.match(readme, /No hosted account or model API key required/i);
  assert.doesNotMatch(readme, /\b(?:better|strongest|superior)\b/i);
  assert.match(contract, /Implemented: bounded semantic plan and task packets, strict result import, pending proposals, and source-rechecked named approval\./);
  assert.match(contract, /Experimental: explicit one-shot Gemini and OpenAI-compatible semantic API execution\./);
  assert.equal(semanticCapability?.status, 'implemented');
  assert.equal(directCapability?.status, 'experimental');
  assert.equal(status.defaults.network, 'deny');
  assert.equal(status.defaults.modelMode, 'deterministic');
  assert.equal(status.defaults.permanentMemory, 'proposal-only');
  assert(semanticCapability.evidence.includes('docs/usage/semantic-setup.md'));
  assert(directCapability.limitations.some((item) => item.includes('outside the model gateway')));
});

test('public usage docs avoid stale task and missing context-file examples while preserving the explicit Recall Map contract', () => {
  assert.equal(existsSync('docs/usage/local-agent-handoff.md'), true);
  assert.equal(existsSync('docs/usage/oaf-compatibility.md'), true);
  const docs = [
    read('ASSIGN_TO_AGENT.md'),
    read('README.md'),
    read('LOCAL_DEVELOPMENT.md'),
    read('docs/START_HERE.md'),
    read('docs/implementation/OAF-031-context-intake-preview-note.md'),
    read('docs/usage/local-agent-handoff.md')
  ].join('\n');
  const readme = read('README.md');
  const handoff = read('docs/usage/local-agent-handoff.md');
  const contract = read('docs/product/memory-recall-developer-first.md');
  const recallMap = read('docs/usage/recall-map.md');
  const compatibility = read('docs/usage/oaf-compatibility.md');
  const rustAcceleration = read('docs/usage/rust-acceleration.md');
  const tokenSavings = read('docs/usage/token-savings.md');
  const sourceCheckoutHeading = '## Developing Memory Recall From A Source Checkout';
  const sourceCheckoutIndex = handoff.indexOf(sourceCheckoutHeading);
  assert.notEqual(sourceCheckoutIndex, -1);
  const normalHandoff = handoff.slice(0, sourceCheckoutIndex);
  const sourceCheckout = handoff.slice(sourceCheckoutIndex);

  assert.equal(docs.includes('docs/context.md'), false);
  assert.equal(docs.includes('oaf task OAF-004'), false);
  assert.match(docs, /npm run task -- <OAF-ID>` only when status names a next task/);
  assert.match(docs, /docs\/usage\/local-agent-handoff\.md/);
  assert.match(docs, /recall handoff/);
  assert.match(docs, /recall token-saver/);
  assert.match(docs, /copy and run/);
  assert.match(docs, /mcp install --client claude-code --dry-run --format json/);
  assert.match(docs, /npm run recall -- memory refine --read-only --root \. --sqlite \.local\/memory\.sqlite --target-active-facts 200 --format json/);
  assert.match(docs, /npm run recall -- context handoff --read-only --from codex --root \. --objective "Prepare handoff" --step "select next agent context" --target codex --changed apps\/web\/app\.js --format json/);
  assert.match(docs, /--apply --confirm <fingerprint>/);
  assert.match(docs, /automatic harness-history importer,\s+write-enabled MCP server/);
  assert.match(docs, /zero model calls, network calls, external writes, adapter\s+enablement, active memory creation, or source-body inclusion/);
  assert.match(docs, /not provider\s+billing claims/);
  assert.match(contract, /# Memory Recall: Developer-First Product Contract/);
  assert.match(contract, /Implemented: native-default, freshness-gated graph reads, reviewed SQLite\s+memory, and twelve read-only MCP tools\. Missing or stale native state fails\s+closed with the exact recovery action; JS\/TS requires explicit compatibility\s+mode\./);
  assert.match(contract, /Experimental: the verified packaged Rust path has compiler-free local evidence across 14 Tier 1 fixtures, while full language and cross-platform release gates remain open\. The bounded cross-repository path currently covers exact Go module resolution/);
  assert.match(contract, /Unsupported: automatic transcript capture, write-capable MCP, hosted sync,\s+general cross-repository analysis beyond the measured exact Go path, and\s+unmeasured Tier 1 capability rows\./);
  assert.equal(contract.includes('million-node indexes.'), false);
  assert.match(readme, /npm install -g memory-recall@latest\nrecall setup\nrecall map --root \. --sqlite \.local\/memory\.sqlite --format summary\nrecall handoff/);
  assert.match(readme, /Source patch candidate: \*\*1\.1\.1\*\*\. Registry version: verify with `npm view memory-recall version`\./);
  assert.match(readme, /`recall setup` creates only local state\. `recall map` is the explicit first\s+read-only repository scan; it does not run silently during setup\./);
  assert.match(normalHandoff, /recall setup\nrecall map --root \. --sqlite \.local\/memory\.sqlite --format summary\nrecall handoff/);
  assert.match(normalHandoff, /`recall setup` creates only local Recall state in the current repository; it\s+does not scan source files\. `recall map` is the explicit first read-only scan\./);
  assert.match(contract, /recall setup\nrecall map --root \. --sqlite \.local\/memory\.sqlite --format summary\nrecall handoff/);
  assert.match(contract, /`recall setup` initializes local Recall state without scanning the repository\.\s+`recall map` is the explicit read-only first scan/);
  assert.match(read('docs/usage/README.md'), /\[Recall Map\]\(recall-map\.md\) - read-only JS\/TS repository map/);
  assert.match(recallMap, /`recall map` is the first explicit read-only command/);
  assert.match(recallMap, /`recall setup` creates only local state\. It does not scan the repository or run\s+Recall Map for you\./);
  assert.match(recallMap, /Every format is local and read-only:/);
  assert.match(recallMap, /no workspace files are written/);
  assert.match(recallMap, /no canonical memory state changes/);
  assert.match(recallMap, /no model or network calls/);
  assert.match(recallMap, /no external adapters enabled/);
  assert.match(recallMap, /no raw source or memory bodies/);
  assert.match(recallMap, /no absolute local workspace paths in the report/);
  assert.doesNotMatch(normalHandoff, /npm run status/);
  assert.match(sourceCheckout, /First run `npm run status`; when it reports `Next task: none`, use the\n`First safe handoff` command it prints or continue below\./);
  assert.match(readme, /Verified packaged Rust reads when a current local index exists/);
  assert.doesNotMatch(rustAcceleration, /Memory Recall uses a Rust core/);
  assert.match(rustAcceleration, /Graph\s+reads default to the verified packaged Rust engine and its local SQLite index/);
  assert.match(rustAcceleration, /It never silently selects the JS engine/);
  assert.match(rustAcceleration, /cargo build --release --manifest-path rust\/Cargo\.toml/);
  assert.match(tokenSavings, /## Experimental Rust evaluation/);
  assert.match(tokenSavings, /source-checkout-only experiment after a local\s+Rust build/i);
  assert.match(tokenSavings, /cargo build --release --manifest-path rust\/Cargo\.toml\nnode scripts\/rust-eval\.mjs/);
  assert.match(tokenSavings, /reads `rust\/target\/release\/oaf` and fetches an external public repository/);
  assert.match(tokenSavings, /unsuitable as a packaged-product benchmark or a\s+stable headline/);
  assert.match(tokenSavings, /does not run during `npm install`, `recall setup`, `recall\s+handoff`, or `recall token-saver`/);
  assert.match(compatibility, /`oaf`/);
  assert.match(compatibility, /oaf:\/\//);
  for (const document of [read('README.md'), read('docs/usage/README.md'), read('docs/usage/local-agent-handoff.md'), read('docs/usage/security-model.md')]) {
    assert.match(document, /memory-recall-developer-first\.md/);
    assert.match(document, /oaf-compatibility\.md/);
  }
  assert.doesNotMatch(readme, /`oaf` compatibility alias/);

  const localIgnore = existsSync('.gitignore') ? read('.gitignore') : read('.npmignore');
  assert.match(localIgnore, /^context-packs\/$/m);
});

test('local handoff guide documents read-only Codex Cursor and Claude paths', () => {
  const guide = read('docs/usage/local-agent-handoff.md');

  assert.match(guide, /From the target repository where you want local Recall state:/);
  assert.match(guide, /npm install -g memory-recall\nrecall setup\nrecall map --root \. --sqlite \.local\/memory\.sqlite --format summary\nrecall handoff/);
  assert.match(guide, /`recall setup` creates only local Recall state in the current repository; it\s+does not scan source files\. `recall map` is the explicit first read-only scan\./);
  assert.doesNotMatch(guide, /memory-recall-1\.0\.3\.tgz/);
  assert.doesNotMatch(guide, /setup is checkout bootstrap/);
  assert.match(guide, /target codex --changed-from-git --format json/);
  assert.match(guide, /npm run handoff:safe/);
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
  assert.match(guide, /recall skill catalog --read-only --root \. --format json/);
  assert.match(guide, /oaf:\/\/workspace\/ws_local\/skills\/catalog/);
  assert.match(guide, /recall mcp inspect --read-only --root \. --format summary/);
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

test('native provider docs match the packaged Rust source-intelligence boundary', () => {
  const guide = read('docs/architecture/native-providers.md');
  const catalog = JSON.parse(read('providers/native/catalog.json'));
  const codeIntelligenceProvider = catalog.providers.find((provider) => provider.id === 'provider:native:code-intelligence:rust');

  assert.equal(codeIntelligenceProvider?.enabledByDefault, true);
  assert.match(guide, /`native\.code-intelligence\.rust` \| on \| Verified packaged Rust code intelligence over the explicit local SQLite index/);
  assert.match(guide, /packaged Rust code-intelligence provider owns source structure, search,\ntrace, impact, and graph projections/);
  assert.match(guide, /Vector, temporal, preference, and episode source kinds remain declared/);
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
