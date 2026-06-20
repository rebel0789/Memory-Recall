import assert from 'node:assert/strict';
import test from 'node:test';

import { buildReleaseReadinessArtifacts, verifyReleaseReadinessArtifacts } from '../packages/release-readiness/src/index.mjs';

test('release readiness artifacts are generated and checked in without drift', async () => {
  const result = await verifyReleaseReadinessArtifacts(process.cwd());

  assert.deepEqual(result.drift, []);
  assert.equal(result.placeholderResult.passed, true);
  assert.equal(result.summary.publicationStatus, 'not-published');
  assert.equal(result.summary.finalMergeStatus, 'not-merged');
  assert.equal(result.summary.humanApprovalRequired, true);
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
