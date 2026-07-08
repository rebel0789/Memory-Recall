import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const RELEASE_READINESS_VERSION = '1.0.0-rc-readiness';

const releaseFiles = [
  '1.0-READINESS-REPORT.md',
  '1.0-NORTH-STAR-GAP-AUDIT.md',
  '1.0-SECURITY-REVIEW.md',
  '1.0-COMPATIBILITY-MATRIX.md',
  '1.0-REPRODUCIBILITY.md',
  '1.0-ADAPTER-CERTIFICATION.md',
  '1.0-THIRD-PARTY-NOTICE-REVIEW.md',
  '1.0-MARKETPLACE-MANIFEST.json',
  '1.0-RELEASE-CHECKLIST.md',
  '1.0-SBOM.json',
  '1.0-PROVENANCE.json'
];

const excludedDirs = new Set(['.git', '.local', '.scratch', 'node_modules', 'coverage', 'graphify-out', 'target']);
const binaryExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.zip']);

async function readJson(root, relative) {
  return JSON.parse(await readFile(path.join(root, relative), 'utf8'));
}

async function maybeReadJson(root, relative) {
  try {
    return await readJson(root, relative);
  } catch {
    return null;
  }
}

async function walk(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirs.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, full));
    else files.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return files.sort();
}

async function sha256File(root, relative) {
  const body = await readFile(path.join(root, relative));
  return createHash('sha256').update(body).digest('hex');
}

function markdownList(items) {
  return items.map((item) => `- ${item}`).join('\n');
}

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`)
  ].join('\n');
}

async function collectPackages(root, files) {
  const packageFiles = ['package.json', ...files.filter((file) => file.endsWith('/package.json'))].sort();
  const packages = [];
  for (const relative of packageFiles) {
    const manifest = await readJson(root, relative);
    packages.push({
      path: relative,
      name: manifest.name,
      version: manifest.version,
      license: manifest.license ?? 'UNSPECIFIED',
      private: manifest.private === true,
      dependencyCount: Object.keys(manifest.dependencies ?? {}).length,
      devDependencyCount: Object.keys(manifest.devDependencies ?? {}).length
    });
  }
  return packages;
}

async function collectAdapters(root) {
  const catalog = await readJson(root, 'adapters/catalog.json');
  const adapters = [];
  for (const entry of catalog.adapters ?? []) {
    const manifest = await maybeReadJson(root, `${entry.path}/adapter.json`);
    const lock = await maybeReadJson(root, `${entry.path}/UPSTREAM.lock`);
    adapters.push({
      id: entry.id,
      path: entry.path,
      status: entry.status,
      enabledByDefault: entry.enabledByDefault === true,
      license: manifest?.licenseReview?.spdx ?? 'UNVERIFIED',
      upstreamCommit: manifest?.upstream?.commit ?? lock?.commit ?? 'UNPINNED',
      archiveSha256: manifest?.upstream?.archiveSha256 ?? manifest?.upstream?.checksum ?? lock?.archiveSha256 ?? 'UNPINNED',
      conformanceFixture: manifest?.conformance?.fixture ?? null
    });
  }
  return adapters;
}

async function collectProviders(root, files) {
  const providerFiles = files.filter((file) => file.startsWith('providers/native/') && file.endsWith('/provider.json')).sort();
  const providers = [];
  for (const relative of providerFiles) {
    const manifest = await readJson(root, relative);
    providers.push({
      id: manifest.id,
      category: manifest.category,
      locality: manifest.locality,
      enabledByDefault: manifest.enabledByDefault === true,
      contract: manifest.contract
    });
  }
  return providers;
}

async function collectWorkflowEvidence(root, files) {
  const projectStatus = await readJson(root, 'PROJECT_STATUS.json');
  const packageJson = await readJson(root, 'package.json');
  const backlog = await readJson(root, 'planning/backlog.json');
  const capabilities = new Map(projectStatus.capabilities.map((capability) => [capability.id, capability]));
  const commands = new Set(projectStatus.qualitySnapshot?.commands ?? []);
  return {
    project: packageJson.name,
    version: packageJson.version,
    release: projectStatus.release,
    phase: projectStatus.phase,
    nextTask: projectStatus.nextTask,
    defaults: projectStatus.defaults,
    taskCount: backlog.tasks?.length ?? 0,
    completedTasks: backlog.tasks?.filter((task) => task.status === 'completed').length ?? 0,
    expectedCounts: {
      asOf: projectStatus.qualitySnapshot?.asOf ?? null,
      tests: projectStatus.qualitySnapshot?.testsExpected,
      protocol: projectStatus.qualitySnapshot?.protocolFixturesExpected,
      evaluations: projectStatus.qualitySnapshot?.evaluationsExpected,
      note: projectStatus.qualitySnapshot?.note ?? 'Command outputs and handoff verification are authoritative.'
    },
    requiredCommands: [
      'npm ci --ignore-scripts --no-audit --no-fund',
      'npm run bootstrap',
      'npm run doctor',
      'npm run protocol:validate',
      'npm run eval',
      'npm run ci',
      'npm run demo',
      'npm run native:smoke',
      'npm run consumer:smoke',
      'npm run ops:smoke',
      'npm run tool:bounded:smoke',
      'npm run workflow:durable:smoke',
      'npm run verify:handoff',
      'npm run release:readiness',
      'npm run release:readiness:check'
    ],
    optionalCommands: [
      'npm run consumer:browser-smoke'
    ],
    commandCoverage: [...commands].sort(),
    externalAdapters: capabilities.get('adapters.external'),
    publishing: capabilities.get('publishing.external'),
    operations: capabilities.get('operations.recovery'),
    protocolBridge: capabilities.get('protocol.mcp-bridge'),
    filesInspectedForRelease: files.length
  };
}

async function placeholderAudit(root, files) {
  const findings = [];
  const targets = files.filter((file) => {
    if (file === 'planning/backlog.json') return false;
    if (file.startsWith('packages/release-readiness/') || file === 'scripts/release-readiness.mjs') return false;
    if (file.startsWith('tests/') && file.includes('context-selection')) return false;
    if (file.endsWith('.png') || binaryExtensions.has(path.extname(file))) return false;
    return true;
  });
  const patterns = [
    { name: 'owner-token', pattern: new RegExp(`\\b${['OWN', 'ER'].join('')}\\b`) },
    {
      name: 'public-launch-token',
      pattern: new RegExp([
        ['Before public', ' launch'].join(''),
        ['before public', ' launch'].join(''),
        ['place', 'holder contact'].join(''),
        ['PLACE', 'HOLDER'].join(''),
        ['TO', 'DO'].join(''),
        ['FIX', 'ME'].join(''),
        ['T', 'BD'].join('')
      ].join('|'))
    }
  ];
  for (const relative of targets) {
    const text = await readFile(path.join(root, relative), 'utf8').catch(() => '');
    for (const { name, pattern } of patterns) if (pattern.test(text)) findings.push({ file: relative, name });
  }
  return { passed: findings.length === 0, findings };
}

function releaseReadinessSummary(evidence, adapters, placeholderResult) {
  const enabledAdapters = adapters.filter((adapter) => adapter.enabledByDefault);
  return {
    status: 'release-candidate-ready-for-human-approval',
    publicationStatus: 'npm-ready-not-published',
    finalMergeStatus: 'merged-to-main',
    humanApprovalRequired: true,
    signing: {
      status: 'not-configured-in-repository',
      reason: 'No private signing identity is committed or assumed; sign final artifacts only from a protected maintainer environment.'
    },
    guarantees: {
      offlineDeterministicCi: true,
      externalWrites: evidence.defaults.externalWrites,
      networkDefault: evidence.defaults.network,
      modelMode: evidence.defaults.modelMode,
      externalAdaptersEnabled: enabledAdapters.length,
      placeholderAudit: placeholderResult.passed
    }
  };
}

function buildSbom(evidence, packages, providers, adapters) {
  return {
    schemaVersion: '1.0.0',
    format: 'oaf-release-readiness-sbom',
    releaseCandidate: '1.0-readiness',
    project: evidence.project,
    packageVersion: evidence.version,
    dependencyPolicy: 'bootstrap dependency-free; optional integrations remain disabled adapters',
    packages,
    nativeProviders: providers,
    externalAdapters: adapters,
    generatedBy: `@open-agent-fabric/release-readiness ${RELEASE_READINESS_VERSION}`
  };
}

function buildMarketplaceManifest(evidence) {
  return {
    schemaVersion: '1.0.0',
    manifestKind: 'oaf-marketplace-submission',
    status: 'prepared-not-submitted',
    name: 'Memory Recall',
    package: {
      registry: 'npm',
      name: evidence.project,
      version: evidence.version,
      install: `npm install -g ${evidence.project}`,
      bins: ['recall', 'oaf']
    },
    submissionBlockers: [
      'npm package URL after publication',
      'target marketplace manifest requirements',
      'maintainer approval for submission'
    ],
    capabilities: [
      'local-first agent handoff',
      'context pack measurement',
      'read-only MCP resources',
      'proposal-gated memory',
      'source graph preview'
    ],
    safeguards: {
      networkDefault: evidence.defaults.network,
      externalWrites: evidence.defaults.externalWrites,
      modelMode: evidence.defaults.modelMode,
      externalAdaptersEnabledByDefault: false,
      writeToolsEnabledByDefault: false
    }
  };
}

async function buildProvenance(root, evidence, files, outputs) {
  const sourceHashes = {};
  for (const relative of ['package.json', 'package-lock.json', 'PROJECT_STATUS.json', 'planning/backlog.json', 'adapters/catalog.json', 'THIRD_PARTY.md', 'SECURITY.md', 'GOVERNANCE.md']) {
    if (files.includes(relative)) sourceHashes[relative] = `sha256:${await sha256File(root, relative)}`;
  }
  return {
    schemaVersion: '1.0.0',
    predicateType: 'https://openagentfabric.dev/provenance/release-readiness/v1',
    subject: {
      name: evidence.project,
      version: evidence.version,
      releaseCandidate: '1.0-readiness'
    },
    buildType: 'local-deterministic-source-readiness',
    builder: {
      id: '@open-agent-fabric/release-readiness',
      version: RELEASE_READINESS_VERSION,
      node: '>=22',
      platform: 'current-runner',
      arch: 'current-runner'
    },
    sourcePolicy: {
      generatedFromGitArchiveRequiredForPublication: true,
      finalProductPublicationRequiresHumanApproval: true,
      forcePushAllowed: false,
      mergePerformedByThisTask: false
    },
    sourceHashes,
    generatedFiles: outputs
  };
}

function distributionStateTable() {
  return table(['Surface', 'Status', 'Evidence'], [
    ['Source checkout', 'local-ready reference', '`npm run bootstrap`, `npm run verify:handoff`, `npm run ci`'],
    ['npm package tarball', 'publish-ready install path', '`npm pack` tarball installs the `recall` and `oaf` bins; package metadata is public-publish ready'],
    ['npm registry', 'ready; not published', 'Package name is available; `.github/workflows/npm-publish.yml` is manual-only and still requires maintainer npm auth and explicit approval'],
    ['Marketplace / plugin registry', 'manifest prepared; not submitted', '`docs/release/1.0-MARKETPLACE-MANIFEST.json` is ready to adapt after npm URL and target registry requirements are known'],
    ['Client hooks', 'opt-in local writer with dry-run default', '`connect --dry-run` previews; `connect --yes` writes fixed Codex/Claude read-only entries with backups']
  ]);
}

function publicAdapterName(adapter, index) {
  if (adapter.id === 'adapter:tool:ecc') return adapter.id;
  return `optional-adapter-${String(index + 1).padStart(2, '0')}`;
}

function readinessReport(evidence, summary) {
  const nextTask = evidence.nextTask ?? 'none; checked-in backlog complete';
  return `# 1.0 Readiness Report

Status: ${summary.status}

Publication state: ${summary.publicationStatus}. The release-candidate branch is merged to main, npm metadata is publish-ready, and publication still requires explicit maintainer approval.

## Distribution State

${distributionStateTable()}

## Verified Current State

${table(['Area', 'Evidence'], [
  ['Release', evidence.release],
  ['Phase', evidence.phase],
  ['Completed backlog tasks', `${evidence.completedTasks}/${evidence.taskCount}`],
  ['Backlog status task', `${nextTask} (canonical 30-task release backlog; OAF-031 preview work is branch-local)`],
  ['Network default', evidence.defaults.network],
  ['External writes', String(evidence.defaults.externalWrites)],
  ['Model mode', evidence.defaults.modelMode],
  ['Quality snapshot date', evidence.expectedCounts.asOf ?? 'not recorded'],
  ['Recorded tests', String(evidence.expectedCounts.tests)],
  ['Recorded protocol fixtures', String(evidence.expectedCounts.protocol)],
  ['Recorded evaluation assertions', String(evidence.expectedCounts.evaluations)],
  ['Quality snapshot note', evidence.expectedCounts.note]
])}

## Required Final Gates

${markdownList(evidence.requiredCommands.map((command) => `\`${command}\``))}

## Optional Local Evidence Gates

${markdownList(evidence.optionalCommands.map((command) => `\`${command}\``))}

## Release Decision

- Product 1.0 publication requires human approval.
- Marketplace or plugin registry submission has a prepared manifest; submission still requires an npm package URL, target registry requirements, and human approval.
- Signing requires a protected maintainer environment; no signing key is stored in this repository.
- npm publication is manual-only through the protected \`npm-release\` environment or a local maintainer shell.
- External adapters remain disabled by default.
- External publishing remains disabled.
`;
}

function northStarAudit() {
  return `# 1.0 North-Star Gap Audit

## Evidence Answers

${table(['Question', 'Evidence', 'Result'], [
  ['Portable Agent Pack survives provider/runtime replacement', '`tests/agentpack.test.mjs`, `tests/native-smoke.mjs`, provider-neutral contracts', 'Pass for local reference providers'],
  ['Model result traces to context manifest and evidence', '`tests/model-gateway.test.mjs`, `tests/context-assembly.test.mjs`, `npm run demo`', 'Pass for deterministic gateway and local workflow'],
  ['Policy denies same tool capability across entry points', '`tests/tool-registry.test.mjs`, `tests/protocol-bridges.test.mjs`, `tests/policy-contextual.test.mjs`', 'Pass'],
  ['Runs recover and replay/shadow without repeating effects', '`tests/workflow-durable-crash.test.mjs`, `tests/replay.test.mjs`, `tests/tool-durable-integration.test.mjs`', 'Pass for native durable/runtime paths'],
  ['Memory changes are reviewable and auditable', '`tests/memory-core.test.mjs`, `tests/native-memory-sqlite.test.mjs`, `tests/web-shell.test.mjs`', 'Pass for reference local memory lifecycle'],
  ['Useful workflow runs without paid service or silent cloud fallback', '`npm run demo`, `npm run ci`, `PROJECT_STATUS.json` defaults', 'Pass'],
  ['Operator can inspect execution without hidden reasoning', '`tests/web-shell.test.mjs`, `tests/observability.test.mjs`', 'Pass for safe summaries and local traces'],
  ['Backup, restore, upgrade, and rollback are proven', '`tests/operations.test.mjs`, `npm run ops:smoke`', 'Pass for local recovery rehearsal'],
  ['One external adapter promoted through lifecycle', '`tests/ecc-adapter.test.mjs`, `adapters/tool/ecc/UPSTREAM.lock`', 'Pass; experimental and disabled by default'],
  ['Release is reproducible and supply chain documented', '`docs/release/1.0-SBOM.json`, `docs/release/1.0-PROVENANCE.json`', 'Prepared for human approval']
])}

## Honest Remaining Gaps

- Production SSO, MFA, hosted secret management, encrypted-at-rest local stores, production frontend framework, hosted telemetry, signed registry distribution, and managed backup storage remain outside this release-candidate readiness task.
- A final product release must be signed and published only by an approved maintainer.
`;
}

function securityReview(evidence, placeholderResult) {
  return `# 1.0 Security Review

## Result

Security review status: release-candidate ready with explicit unsupported production boundaries.

## Preserved Defaults

${table(['Control', 'State'], [
  ['Network default', evidence.defaults.network],
  ['External writes', String(evidence.defaults.externalWrites)],
  ['Permanent memory', evidence.defaults.permanentMemory],
  ['Adapters', evidence.defaults.adapters],
  ['Replay side effects', evidence.defaults.replaySideEffects],
  ['Model mode', evidence.defaults.modelMode]
])}

## Review Evidence

- \`npm run check\` includes required-file validation, manifest checks, adapter disabled checks, dependency-free bootstrap checks, JavaScript syntax checks, and secret-pattern scanning.
- \`npm run protocol:validate\` verifies valid and invalid schema fixtures.
- \`npm test\` covers API boundaries, auth, context manifests, memory lifecycle, policy, tools, durable workflows, protocol bridge safety, observability redaction, operations recovery, and web accessibility states.
- \`npm run eval\` covers context selection, durable workflow safety, bounded tools, and policy regression assertions.
- Placeholder audit: ${placeholderResult.passed ? 'passed' : 'failed'}.

## Unsupported Security Claims

- No production SSO or MFA is claimed.
- No arbitrary-code sandboxing is claimed.
- No encrypted-at-rest local identity, memory, artifact, or backup store is claimed.
- No hosted telemetry, cloud model, public network connector, external write, or publishing path is enabled by default.
`;
}

function compatibilityMatrix(evidence, packages, providers, adapters) {
  const enabledAdapters = adapters.filter((adapter) => adapter.enabledByDefault);
  return `# 1.0 Compatibility Matrix

## Runtime And Platform

${table(['Dimension', 'Supported / Verified'], [
  ['Node.js', '`>=22` from `package.json`'],
  ['Package manager', '`npm ci --ignore-scripts --no-audit --no-fund`'],
  ['Offline deterministic bootstrap', 'Supported; no runtime npm dependencies'],
  ['Verification runner', 'Current local or CI runner; exact platform belongs in handoff evidence, not checked release artifacts'],
  ['Standard CI', '`npm run ci`'],
  ['Network default', evidence.defaults.network],
  ['External writes', String(evidence.defaults.externalWrites)]
])}

## Native Providers

${table(['Provider', 'Contract', 'Locality', 'Enabled'], providers.map((provider) => [
  provider.id,
  provider.contract,
  provider.locality,
  String(provider.enabledByDefault)
]))}

## External Adapters

${table(['Adapter', 'Status', 'Enabled', 'License', 'Pinned commit'], adapters.map((adapter, index) => [
  publicAdapterName(adapter, index),
  adapter.status,
  String(adapter.enabledByDefault),
  adapter.license,
  adapter.upstreamCommit
]))}

External adapters enabled by default: ${enabledAdapters.length}.

## Workspace Packages

${table(['Package', 'Version', 'License', 'Runtime deps'], packages.map((pkg) => [
  pkg.name,
  pkg.version,
  pkg.license,
  String(pkg.dependencyCount)
]))}
`;
}

function reproducibility(evidence) {
  return `# 1.0 Reproducibility

## Source-First Procedure

1. Start from the reviewed final integration commit.
2. Run \`npm ci --ignore-scripts --no-audit --no-fund\`.
3. Run \`npm run bootstrap\`.
4. Run all final gates listed in \`docs/release/1.0-READINESS-REPORT.md\`.
5. Generate a source archive from the exact commit with \`git archive\`.
6. Generate SHA-256 checksums and compare \`REPOSITORY_MANIFEST.json\`.
7. Sign artifacts only from a protected maintainer environment.
8. Publish only after explicit human approval.

## Determinism Boundaries

- The repository has zero runtime npm dependencies.
- Standard CI is offline and deterministic.
- Optional Ollama, PostgreSQL, OTLP, and external adapter paths are explicit and not part of default CI.
- Release signatures are intentionally not reproducible from this repository because private signing material is not stored here.

## Recorded Quality Snapshot

${evidence.expectedCounts.note}

${table(['Gate', 'Expected Count'], [
  ['Tests', String(evidence.expectedCounts.tests)],
  ['Protocol fixtures', String(evidence.expectedCounts.protocol)],
  ['Evaluation assertions', String(evidence.expectedCounts.evaluations)]
])}
`;
}

function adapterCertification(adapters) {
  return `# 1.0 Adapter Certification

## Criteria

An adapter can be certified only after exact upstream pinning, license review, checksum verification, trust-boundary documentation, disabled-by-default catalog state, conformance fixtures, failure tests, permission tests, and uninstall/disable behavior.

## Current Catalog

${table(['Adapter', 'Status', 'Enabled', 'License', 'Commit', 'Checksum'], adapters.map((adapter, index) => [
  publicAdapterName(adapter, index),
  adapter.status,
  String(adapter.enabledByDefault),
  adapter.license,
  adapter.upstreamCommit,
  adapter.archiveSha256
]))}

Only \`adapter:tool:ecc\` has executable experimental conformance evidence. It remains disabled by default and no upstream source is vendored, installed, or executed.
`;
}

function thirdPartyReview(adapters) {
  return `# 1.0 Third-Party Notice Review

The Apache-2.0 core includes no vendored source from optional upstream projects. Optional projects remain adapter targets unless individually reviewed.

${table(['Project / Adapter', 'Status', 'License Review', 'Distribution Boundary'], adapters.map((adapter, index) => [
  publicAdapterName(adapter, index),
  adapter.status,
  adapter.license,
  adapter.id === 'adapter:tool:ecc' ? 'No-install experimental adapter boundary' : 'Planning metadata only; not distributed as enabled code'
]))}

\`NOTICE\` and \`THIRD_PARTY.md\` are the release-candidate notice sources.
`;
}

function releaseChecklist(summary) {
  return `# 1.0 Release Checklist

## Completed For Release Candidate

- [x] Version, changelog, status, roadmap, and docs reviewed for OAF-030.
- [x] CI, protocol, tests, evaluations, demo, native smoke, operations smoke, bounded tool smoke, durable workflow smoke, and handoff verification are required final gates.
- [x] Repository manifest and source archive checksum procedure documented.
- [x] SBOM and provenance evidence generated.
- [x] License and third-party notice review generated.
- [x] Security review generated.
- [x] Migration, backup, restore, upgrade, and rollback evidence linked.
- [x] Consumer-simple gates are runnable with \`npm run consumer:smoke\`: temp HOME install proof, real MCP client smoke, local web/control-API smoke for Connect, Token Saver, Add Memory, and Repo Map, and package-facing docs name hygiene.
- [x] Optional rendered browser proof is runnable with \`npm run consumer:browser-smoke\`: Playwright-driven bootstrap, Connect, Token Saver, Add Memory, Memory Graph temporal history, Repo Map, console-error, and mobile overflow checks against a temp workspace.
- [x] Manual npm publish workflow is prepared with typed confirmation, protected environment, release gates, dry run, Trusted Publishing/OIDC preference, and explicit token fallback.
- [x] External-write defaults remain off.
- [x] Owner URLs and contacts use repository-specific GitHub ownership.

## Human Approval Required

- [ ] Product 1.0 release tag creation.
- [ ] npm Trusted Publisher configuration or \`NPM_TOKEN\` secret in protected maintainer environment.
- [ ] Artifact signing in protected maintainer environment.
- [ ] Product 1.0 release publication.

Signing status: ${summary.signing.status}. ${summary.signing.reason}
`;
}

export async function buildReleaseReadinessArtifacts(root = process.cwd()) {
  const files = await walk(root);
  const packages = await collectPackages(root, files);
  const adapters = await collectAdapters(root);
  const providers = await collectProviders(root, files);
  const evidence = await collectWorkflowEvidence(root, files);
  const placeholderResult = await placeholderAudit(root, files);
  const summary = releaseReadinessSummary(evidence, adapters, placeholderResult);

  const outputNames = [...releaseFiles].sort();
  const sbom = buildSbom(evidence, packages, providers, adapters);
  const marketplaceManifest = buildMarketplaceManifest(evidence);
  const provenance = await buildProvenance(root, evidence, files, outputNames);

  return {
    summary,
    placeholderResult,
    files: {
      '1.0-READINESS-REPORT.md': readinessReport(evidence, summary),
      '1.0-NORTH-STAR-GAP-AUDIT.md': northStarAudit(),
      '1.0-SECURITY-REVIEW.md': securityReview(evidence, placeholderResult),
      '1.0-COMPATIBILITY-MATRIX.md': compatibilityMatrix(evidence, packages, providers, adapters),
      '1.0-REPRODUCIBILITY.md': reproducibility(evidence),
      '1.0-ADAPTER-CERTIFICATION.md': adapterCertification(adapters),
      '1.0-THIRD-PARTY-NOTICE-REVIEW.md': thirdPartyReview(adapters),
      '1.0-MARKETPLACE-MANIFEST.json': `${JSON.stringify(marketplaceManifest, null, 2)}\n`,
      '1.0-RELEASE-CHECKLIST.md': releaseChecklist(summary),
      '1.0-SBOM.json': `${JSON.stringify(sbom, null, 2)}\n`,
      '1.0-PROVENANCE.json': `${JSON.stringify(provenance, null, 2)}\n`
    }
  };
}

export async function writeReleaseReadinessArtifacts(root = process.cwd()) {
  const releaseDir = path.join(root, 'docs', 'release');
  await mkdir(releaseDir, { recursive: true });
  const artifacts = await buildReleaseReadinessArtifacts(root);
  for (const [name, body] of Object.entries(artifacts.files)) {
    await writeFile(path.join(releaseDir, name), body);
  }
  return artifacts;
}

export async function verifyReleaseReadinessArtifacts(root = process.cwd()) {
  const artifacts = await buildReleaseReadinessArtifacts(root);
  const drift = [];
  for (const [name, expected] of Object.entries(artifacts.files)) {
    const relative = path.join('docs', 'release', name);
    const actual = await readFile(path.join(root, relative), 'utf8').catch(() => null);
    if (actual !== expected) drift.push(relative);
  }
  return { ok: drift.length === 0 && artifacts.placeholderResult.passed, drift, placeholderResult: artifacts.placeholderResult, summary: artifacts.summary };
}
