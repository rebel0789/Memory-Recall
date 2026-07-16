import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildReleaseReadinessArtifacts, verifyReleaseReadinessArtifacts } from '../packages/release-readiness/src/index.mjs';
import packageJson from '../package.json' with { type: 'json' };

async function countDeclaredNodeTests() {
  const testFiles = (await readdir('tests')).filter((file) => file.endsWith('.test.mjs')).sort();
  let total = 0;
  for (const file of testFiles) {
    const body = await readFile(path.join('tests', file), 'utf8');
    total += body.match(/^test\s*\(/gm)?.length ?? 0;
  }
  return total;
}

test('make clean target does not remove local state or environment files', async () => {
  const makefile = await readFile('Makefile', 'utf8');
  const cleanTarget = makefile.match(/^clean:\n((?:\t.*\n?)*)/m)?.[1] ?? '';
  assert.doesNotMatch(cleanTarget, /\.env/);
  assert.doesNotMatch(cleanTarget, /\.local/);
});

test('uninstall guide reserves a dry-run boundary before any future local-state deletion', async () => {
  const guide = await readFile('docs/usage/uninstall.md', 'utf8');
  assert.match(guide, /recall uninstall --dry-run/);
  assert.match(guide, /does not exist today|not available today/i);
});

test('release readiness artifacts are generated and checked in without drift', async () => {
  const result = await verifyReleaseReadinessArtifacts(process.cwd());
  const allowedPackageArchiveDrift = existsSync('.git') ? [] : ['docs/release/1.0-PROVENANCE.json'];
  const unexpectedDrift = result.drift.filter((filePath) => !allowedPackageArchiveDrift.includes(filePath));

  assert.deepEqual(unexpectedDrift, []);
  if (existsSync('.git')) assert.deepEqual(result.drift, []);
  assert.equal(result.placeholderResult.passed, true);
  assert.equal(result.summary.publicationStatus, 'npm-published');
  assert.equal(result.summary.finalMergeStatus, 'maintainer-merge-required');
  assert.equal(result.summary.humanApprovalRequired, true);
});

test('release readiness ignores Cargo target build output directories', async () => {
  const fixtureDirectory = path.join('rust', 'target', 'oaf-release-readiness-fixture');
  const fixtureFile = path.join(fixtureDirectory, 'generated.txt');
  mkdirSync(fixtureDirectory, { recursive: true });
  const placeholderToken = ['TO', 'DO'].join('');
  writeFileSync(fixtureFile, `${placeholderToken} generated Cargo build output should not be scanned.\n`);

  try {
    const artifacts = await buildReleaseReadinessArtifacts(process.cwd());
    assert.equal(artifacts.placeholderResult.findings.some((finding) => finding.file.startsWith('rust/target/')), false);
    assert.equal(artifacts.placeholderResult.passed, true);
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('repository manifest excludes local ignored handoff and browser artifacts', async () => {
  const manifest = JSON.parse(await readFile('REPOSITORY_MANIFEST.json', 'utf8'));
  const paths = manifest.files.map((file) => file.path);

  assert.equal(paths.some((filePath) => filePath.startsWith('.playwright-cli/')), false);
  assert.equal(paths.some((filePath) => filePath.startsWith('.scratch/')), false);
  assert.equal(paths.some((filePath) => filePath.startsWith('.claude/')), false);
  assert.equal(paths.some((filePath) => filePath.startsWith('.cursor/')), false);
  assert.equal(paths.some((filePath) => filePath.startsWith('.github/')), false);
  assert.equal(paths.some((filePath) => filePath.startsWith('context-packs/')), false);
  assert.equal(paths.some((filePath) => filePath.startsWith('graphify-out/')), false);
  assert.equal(paths.some((filePath) => filePath.startsWith('output/')), false);
  assert.equal(paths.some((filePath) => filePath.startsWith('docs/research/')), false);
  assert.equal(paths.some((filePath) => filePath.startsWith('docs/superpowers/')), false);
  assert.equal(manifest.exclusions.includes('.playwright-cli/**'), true);
  assert.equal(manifest.exclusions.includes('.scratch/**'), true);
  assert.equal(manifest.exclusions.includes('.claude/**'), true);
  assert.equal(manifest.exclusions.includes('.cursor/**'), true);
  assert.equal(manifest.exclusions.includes('.github/**'), true);
  assert.equal(manifest.exclusions.includes('context-packs/**'), true);
  assert.equal(manifest.exclusions.includes('graphify-out/**'), true);
  assert.equal(manifest.exclusions.includes('output/**'), true);
  assert.equal(manifest.exclusions.includes('docs/research/**'), true);
  assert.equal(manifest.exclusions.includes('docs/superpowers/**'), true);
});

test('repository manifest generator ignores Cargo target build output directories', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-manifest-target-'));
  mkdirSync(path.join(root, 'rust', 'target', 'debug'), { recursive: true });
  writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  writeFileSync(path.join(root, 'rust', 'target', 'debug', 'generated.txt'), 'generated build output\n');

  const result = spawnSync(process.execPath, [path.resolve('scripts/generate-manifest.mjs')], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);

  const manifest = JSON.parse(readFileSync(path.join(root, 'REPOSITORY_MANIFEST.json'), 'utf8'));
  const paths = manifest.files.map((file) => file.path);
  assert.equal(paths.includes('README.md'), true);
  assert.equal(paths.some((filePath) => filePath.startsWith('rust/target/')), false);
});

test('npm package contains the runtime contract without checkout-only test weight', () => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const [pack] = JSON.parse(result.stdout);
  const paths = pack.files.map((file) => file.path);

  for (const prefix of ['.scratch/', '.claude/', '.cursor/', '.github/', '.local/', 'context-packs/', 'graphify-out/', 'output/', 'docs/research/', 'docs/superpowers/']) {
    assert.equal(paths.some((filePath) => filePath.startsWith(prefix)), false, prefix);
  }
  assert.equal(paths.includes('.env'), false);
  if (existsSync('.git')) assert.equal(paths.includes('.gitignore'), true);
  assert.equal(paths.includes('.npmignore'), true);
  assert.equal(paths.includes('README.md'), true);
  assert.equal(paths.includes('apps/cli/oaf.mjs'), true);
  assert.equal(paths.includes('scripts/verify-handoff.mjs'), true);
  assert.equal(paths.includes('scripts/rust-ingest-quality.mjs'), false);
  assert.equal(paths.includes('scripts/rust-intelligence-quality.mjs'), false);
  assert.equal(paths.includes('scripts/code-intelligence-batch-d.mjs'), false);
  assert.equal(paths.includes('scripts/code-intelligence-batch-e.mjs'), false);
  assert.equal(paths.includes('scripts/code-intelligence-language-batch.mjs'), false);
  assert.equal(paths.includes('scripts/code-intelligence-phase2-tier1.mjs'), false);
  assert.equal(paths.includes('evals/code-intelligence/capability-matrix.v1.json'), false);
  assert.equal(paths.some((filePath) => filePath.startsWith('rust/target/')), false);
  assert.equal(paths.some((filePath) => /\.(?:node|dylib|so|dll|exe)$/u.test(filePath)), false);
  assert.equal(paths.some((filePath) => filePath.startsWith('tests/')), false);
  assert.equal(paths.some((filePath) => filePath.startsWith('adapters/') && filePath.endsWith('/README.md')), false);
  assert.equal(paths.some((filePath) => filePath.startsWith('adapters/') && filePath.endsWith('/UPSTREAM.lock')), true);
  assert.ok(pack.entryCount <= 852, `npm package has ${pack.entryCount} files; expected at most 852`);
  assert.ok(pack.size <= 1_260_000, `npm package is ${pack.size} compressed bytes; expected at most 1,260,000`);
  assert.ok(pack.unpackedSize <= 5_500_000, `npm package is ${pack.unpackedSize} unpacked bytes; expected at most 5,500,000`);
});

test('installed npm package setup does not re-pack generated local state', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oaf-package-repack-'));
  const packDir = path.join(root, 'pack');
  const prefix = path.join(root, 'prefix');
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  mkdirSync(packDir, { recursive: true });
  mkdirSync(prefix, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(path.join(work, 'src'), { recursive: true });
  writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'installed-map-target' }, null, 2));
  writeFileSync(path.join(work, 'src', 'index.ts'), 'export function installedMapFixture() { return "target repository only"; }\n');

  const packed = spawnSync('npm', ['pack', '--pack-destination', packDir, '--json'], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const [{ filename }] = JSON.parse(packed.stdout);
  const tarball = path.join(packDir, filename);

  const installed = spawnSync('npm', ['install', '-g', '--prefix', prefix, tarball, '--ignore-scripts', '--no-audit', '--no-fund'], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(installed.status, 0, installed.stderr);

  const packageRoot = path.join(prefix, 'lib', 'node_modules', 'memory-recall');
  const recall = path.join(prefix, 'bin', 'recall');
  const oaf = path.join(prefix, 'bin', 'oaf');
  assert.equal(existsSync(recall), true);
  assert.equal(existsSync(oaf), true);
  const setup = spawnSync(recall, ['setup'], { cwd: work, encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /created only local state/i);
  assert.match(setup.stdout, /recall map --root \. --sqlite \.local\/memory\.sqlite --format summary/);
  assert.equal(existsSync(path.join(packageRoot, '.local', 'state.json')), false);
  assert.equal(existsSync(path.join(work, '.local', 'state.json')), true);
  assert.equal(existsSync(path.join(work, '.local', 'artifacts')), true);
  const env = { ...process.env, HOME: home, PATH: `${path.join(prefix, 'bin')}${path.delimiter}${process.env.PATH}` };
  const map = spawnSync(recall, ['map', '--root', '.', '--sqlite', '.local/memory.sqlite', '--changed', 'src/index.ts', '--format', 'summary'], { cwd: work, encoding: 'utf8', env });
  assert.equal(map.status, 0, map.stderr);
  assert.match(map.stdout, /# Recall Map/);
  assert.match(map.stdout, /src\/index\.ts/);
  assert.doesNotMatch(map.stdout, new RegExp(packageRoot.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  assert.equal(existsSync(path.join(packageRoot, '.local', 'state.json')), false);
  const truthFloor = spawnSync(recall, ['benchmark', 'truth-floor', '--suite', 'benchmark-truth-floor', '--dataset', 'evals/benchmark-truth-floor/cases.v1.json', '--format', 'json'], { cwd: work, encoding: 'utf8', env });
  assert.equal(truthFloor.status, 0, truthFloor.stderr);
  assert.equal(JSON.parse(truthFloor.stdout).gateDecision, 'pass');
  const temporal = spawnSync(recall, ['bench', 'temporal', '--read-only', '--root', '.', '--format', 'json'], { cwd: work, encoding: 'utf8', env });
  assert.equal(temporal.status, 0, temporal.stderr);
  assert.equal(JSON.parse(temporal.stdout).headline.oafWins, true);
  const hookPlan = spawnSync(oaf, ['hook', 'install', '--agent', 'codex', '--dry-run', '--format', 'json'], { cwd: work, encoding: 'utf8', env });
  assert.equal(hookPlan.status, 0, hookPlan.stderr);
  const hookReport = JSON.parse(hookPlan.stdout);
  assert.equal(hookReport.harnessSetup.desiredHooks.command, 'oaf hook context --read-only --format text');
  assert.match(hookReport.manualHookSnippet.content, /oaf hook context --read-only --format text/);
  const hookSnippet = JSON.parse(hookReport.manualHookSnippet.content);
  const hookCommand = hookSnippet.hooks.SessionStart[0].hooks[0].command;
  const hookRun = spawnSync(hookCommand, { cwd: work, shell: true, encoding: 'utf8', env });
  assert.equal(hookRun.status, 0, hookRun.stderr);
  assert.match(hookRun.stdout, /OAF HOOK CONTEXT/);
  assert.match(hookReport.harnessSetup.manualConfigSnippet.content, /command = "oaf"/);
  assert.match(hookReport.harnessSetup.manualConfigSnippet.content, /args = \["mcp", "resources", "--read-only", "--stdio"\]/);
  assert.equal(hookReport.harnessSetup.desiredServer.command, 'oaf');
  assert.deepEqual(hookReport.harnessSetup.desiredServer.args, ['mcp', 'resources', '--read-only', '--stdio']);
  const mcpRun = spawnSync(hookReport.harnessSetup.desiredServer.command, hookReport.harnessSetup.desiredServer.args, {
    cwd: work,
    input: '{"jsonrpc":"2.0","id":1,"method":"resources/list"}\n',
    encoding: 'utf8',
    env
  });
  assert.equal(mcpRun.status, 0, mcpRun.stderr);
  const mcpResponse = JSON.parse(mcpRun.stdout.trim());
  assert.equal(mcpResponse.result.resources.length, 5);

  const repacked = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: packageRoot, encoding: 'utf8' });
  assert.equal(repacked.status, 0, repacked.stderr);
  const [pack] = JSON.parse(repacked.stdout);
  const paths = pack.files.map((file) => file.path);

  assert.equal(paths.includes('.npmignore'), true);
  assert.equal(paths.includes('.env'), false);
  for (const prefix of ['.local/', '.scratch/', '.claude/', '.cursor/', '.github/', 'context-packs/', 'graphify-out/', 'output/', 'docs/research/', 'docs/superpowers/']) {
    assert.equal(paths.some((filePath) => filePath.startsWith(prefix)), false, prefix);
  }
});

test('package-facing and product markdown docs avoid competitor names', () => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const [pack] = JSON.parse(result.stdout);
  const productDocs = readdirSync('docs/product')
    .filter((filePath) => filePath.endsWith('.md'))
    .map((filePath) => path.join('docs/product', filePath));
  const docs = [
    ...new Set([
      ...pack.files.map((file) => file.path).filter((filePath) => filePath.endsWith('.md')),
      ...productDocs
    ])
  ];
  const forbidden = /Headroom|AgentMemory|Graphiti|Zep|Mem0|Letta|LangMem|Supermemory|Microsoft ISE|TrueFoundry|MemRefine|Deployment-Time Memorization|Experience Compression Spectrum|create-context-graph|DataHub|Neo4j Labs|Neo4j|Graphify|Understand Anything|codebase-memory-mcp|DeusData|\bcbm\b/i;

  for (const filePath of docs) {
    const body = readFileSync(filePath, 'utf8');
    assert.doesNotMatch(body, forbidden, filePath);
  }
});

test('release readiness SBOM and provenance preserve disabled adapters and local defaults', async () => {
  const artifacts = await buildReleaseReadinessArtifacts(process.cwd());
  const sbom = JSON.parse(artifacts.files['1.0-SBOM.json']);
  const provenance = JSON.parse(artifacts.files['1.0-PROVENANCE.json']);

  assert.equal(sbom.dependencyPolicy.includes('dependency-free'), true);
  assert.equal(sbom.externalAdapters.length, 12);
  assert.equal(sbom.externalAdapters.filter((adapter) => adapter.enabledByDefault).length, 0);
  assert.equal(sbom.externalAdapters.filter((adapter) => adapter.status === 'experimental').length, 1);
  assert.equal(sbom.packages.every((pkg) => pkg.dependencyCount === 0), true);
  assert.equal(provenance.sourcePolicy.finalProductPublicationRequiresHumanApproval, true);
  assert.equal(provenance.sourcePolicy.mergePerformedByThisTask, false);
  assert.equal(provenance.generatedFiles.includes('1.0-READINESS-REPORT.md'), true);
  assert.equal(provenance.generatedFiles.includes('1.0-MARKETPLACE-MANIFEST.json'), true);
});

test('release readiness quality snapshot matches current release evidence', async () => {
  const artifacts = await buildReleaseReadinessArtifacts(process.cwd());
  const report = artifacts.files['1.0-READINESS-REPORT.md'];
  const reproducibility = artifacts.files['1.0-REPRODUCIBILITY.md'];
  const provenance = JSON.parse(artifacts.files['1.0-PROVENANCE.json']);
  const declaredTests = await countDeclaredNodeTests();
  const protocolFixtures = JSON.parse(await readFile('examples/protocol/compatibility/fixtures.json', 'utf8')).fixtures.length;
  const projectStatus = JSON.parse(await readFile('PROJECT_STATUS.json', 'utf8'));

  assert.equal(projectStatus.release, packageJson.version);
  assert.match(report, new RegExp(`\\| Quality snapshot date \\| ${projectStatus.qualitySnapshot.asOf} \\|`));
  assert.match(report, new RegExp(`\\| Recorded tests \\| ${declaredTests} \\|`));
  assert.match(report, new RegExp(`\\| Recorded protocol fixtures \\| ${protocolFixtures} \\|`));
  assert.match(report, /\| Recorded evaluation assertions \| 144 \|/);
  assert.match(report, /Counts are a dated snapshot; command results and HANDOFF_VERIFICATION\.json are authoritative\./);
  assert.match(report, /\| Source checkout \| local-ready reference \|/);
  assert.match(report, /\| npm package tarball \| publish-ready install path \|/);
  assert.match(report, /\| npm registry \| published \|/);
  assert.match(report, /patch releases still require maintainer npm auth and explicit approval/);
  assert.match(report, /\| Marketplace \/ plugin registry \| manifest prepared; not submitted \|/);
  assert.match(report, /\| Client hooks \| opt-in local writer with dry-run default \|/);
  assert.match(report, /`connect --dry-run` previews; `connect --yes` writes fixed Codex\/Claude read-only entries with backups/);
  assert.match(report, /npm run consumer:smoke/);
  assert.match(report, /npm run consumer:browser-smoke/);
  assert.match(report, /## Public Product Evidence/);
  assert.match(report, /\[Support matrix\]\(\.\.\/usage\/support-matrix\.md\)/);
  assert.match(report, /\[Benchmark proof\]\(\.\.\/benchmarks\.md\)/);
  assert.doesNotMatch(report, /canonical 30-task release backlog|OAF-031 preview work/i);
  assert.match(reproducibility, /## Recorded Quality Snapshot/);
  assert.match(reproducibility, /## Public Claim Evidence/);
  assert.match(reproducibility, /docs\/usage\/support-matrix\.md/);
  assert.match(reproducibility, /docs\/benchmarks\.md/);
  assert.match(reproducibility, new RegExp(`\\| Tests \\| ${declaredTests} \\|`));
  assert.match(reproducibility, new RegExp(`\\| Protocol fixtures \\| ${protocolFixtures} \\|`));
  assert.equal(provenance.subject.name, 'memory-recall');
  assert.equal(provenance.builder.id, 'memory-recall/release-readiness');
  assert.match(provenance.sourceHashes['docs/usage/support-matrix.md'], /^sha256:/);
  assert.match(provenance.sourceHashes['docs/benchmarks.md'], /^sha256:/);

  const checklist = artifacts.files['1.0-RELEASE-CHECKLIST.md'];
  assert.match(checklist, /Consumer-simple gates are runnable with `npm run consumer:smoke`: temp HOME install proof, real MCP client smoke, local web\/control-API smoke for Connect, Token Saver, Add Memory, and Repo Map, and package-facing docs name hygiene/);
  assert.match(checklist, /Optional rendered browser proof is runnable with `npm run consumer:browser-smoke`: Playwright-driven bootstrap, Connect, Token Saver, Add Memory, Memory Graph temporal history, Repo Map, console-error, and mobile overflow checks against a temp workspace/);
  assert.match(checklist, /Manual npm publish workflow is prepared with typed confirmation, protected environment, release gates, dry run, Trusted Publishing\/OIDC preference, and explicit token fallback/);
});

test('marketplace manifest is prepared without claiming submission', async () => {
  const artifacts = await buildReleaseReadinessArtifacts(process.cwd());
  const manifest = JSON.parse(artifacts.files['1.0-MARKETPLACE-MANIFEST.json']);

  assert.equal(manifest.status, 'prepared-not-submitted');
  assert.equal(manifest.package.name, 'memory-recall');
  assert.equal(manifest.package.version, packageJson.version);
  assert.equal(manifest.package.install, 'npm install -g memory-recall');
  assert.equal(manifest.package.url, `https://www.npmjs.com/package/memory-recall/v/${packageJson.version}`);
  assert.deepEqual(manifest.package.bins, ['recall', 'oaf']);
  assert.equal(manifest.safeguards.networkDefault, 'deny');
  assert.equal(manifest.safeguards.externalWrites, false);
  assert.equal(manifest.safeguards.externalAdaptersEnabledByDefault, false);
  assert.equal(manifest.submissionBlockers.includes('npm package URL after publication'), false);
  assert.equal(manifest.submissionBlockers.includes('target marketplace manifest requirements'), true);
});

test('release readiness preserves package license and adapter checksum evidence', async () => {
  const artifacts = await buildReleaseReadinessArtifacts(process.cwd());
  const sbom = JSON.parse(artifacts.files['1.0-SBOM.json']);
  const certification = artifacts.files['1.0-ADAPTER-CERTIFICATION.md'];
  const packageLicenses = sbom.packages.map((pkg) => [pkg.path, pkg.license]);
  const ecc = sbom.externalAdapters.find((adapter) => adapter.id === 'adapter:tool:ecc');

  assert.equal(packageLicenses.every(([, license]) => license !== 'UNSPECIFIED'), true);
  assert.equal(ecc.archiveSha256, 'sha256:c4a147dfb3766ee4eaedf74efbbc62cb5cdab014a5df98bee67020fb05871ae0');
  assert.match(certification, /adapter:tool:ecc \| experimental \| false \| MIT \| 34faa39bd3cd496a0aece0245f2b7e38b7923abc \| sha256:c4a147dfb3766ee4eaedf74efbbc62cb5cdab014a5df98bee67020fb05871ae0/);
});

test('release reports answer the required north-star and security questions', async () => {
  const artifacts = await buildReleaseReadinessArtifacts(process.cwd());
  const northStar = artifacts.files['1.0-NORTH-STAR-GAP-AUDIT.md'];
  const security = artifacts.files['1.0-SECURITY-REVIEW.md'];
  const reproducibility = artifacts.files['1.0-REPRODUCIBILITY.md'];

  for (const required of [
    'Portable Agent Pack survives provider/runtime replacement',
    'Model result traces to context manifest and evidence',
    'Policy denies same tool capability across entry points',
    'Backup, restore, upgrade, and rollback are proven',
    'Release is reproducible and supply chain documented'
  ]) {
    assert.match(northStar, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(security, /No production SSO or MFA is claimed/);
  assert.match(security, /No arbitrary-code sandboxing is claimed/);
  assert.match(reproducibility, /Publish only after explicit human approval/);
});
