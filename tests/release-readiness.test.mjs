import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { buildReleaseReadinessArtifacts, verifyReleaseReadinessArtifacts } from '../packages/release-readiness/src/index.mjs';

async function countDeclaredNodeTests() {
  const testFiles = (await readdir('tests')).filter((file) => file.endsWith('.test.mjs')).sort();
  let total = 0;
  for (const file of testFiles) {
    const body = await readFile(path.join('tests', file), 'utf8');
    total += body.match(/^test\s*\(/gm)?.length ?? 0;
  }
  return total;
}

test('release readiness artifacts are generated and checked in without drift', async () => {
  const result = await verifyReleaseReadinessArtifacts(process.cwd());

  assert.deepEqual(result.drift, []);
  assert.equal(result.placeholderResult.passed, true);
  assert.equal(result.summary.publicationStatus, 'not-published');
  assert.equal(result.summary.finalMergeStatus, 'not-merged');
  assert.equal(result.summary.humanApprovalRequired, true);
});

test('repository manifest excludes local ignored handoff and browser artifacts', async () => {
  const manifest = JSON.parse(await readFile('REPOSITORY_MANIFEST.json', 'utf8'));
  const paths = manifest.files.map((file) => file.path);

  assert.equal(paths.some((filePath) => filePath.startsWith('.playwright-cli/')), false);
  assert.equal(paths.some((filePath) => filePath.startsWith('context-packs/')), false);
  assert.equal(paths.some((filePath) => filePath.startsWith('graphify-out/')), false);
  assert.equal(manifest.exclusions.includes('.playwright-cli/**'), true);
  assert.equal(manifest.exclusions.includes('context-packs/**'), true);
  assert.equal(manifest.exclusions.includes('graphify-out/**'), true);
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
});

test('release readiness quality snapshot matches current release evidence', async () => {
  const artifacts = await buildReleaseReadinessArtifacts(process.cwd());
  const report = artifacts.files['1.0-READINESS-REPORT.md'];
  const reproducibility = artifacts.files['1.0-REPRODUCIBILITY.md'];
  const declaredTests = await countDeclaredNodeTests();
  const protocolFixtures = JSON.parse(await readFile('examples/protocol/compatibility/fixtures.json', 'utf8')).fixtures.length;

  assert.match(report, /\| Quality snapshot date \| 2026-06-25 \|/);
  assert.match(report, new RegExp(`\\| Recorded tests \\| ${declaredTests} \\|`));
  assert.match(report, new RegExp(`\\| Recorded protocol fixtures \\| ${protocolFixtures} \\|`));
  assert.match(report, /\| Recorded evaluation assertions \| 144 \|/);
  assert.match(report, /Counts are a dated snapshot; command results and HANDOFF_VERIFICATION\.json are authoritative\./);
  assert.match(reproducibility, /## Recorded Quality Snapshot/);
  assert.match(reproducibility, new RegExp(`\\| Tests \\| ${declaredTests} \\|`));
  assert.match(reproducibility, new RegExp(`\\| Protocol fixtures \\| ${protocolFixtures} \\|`));
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
