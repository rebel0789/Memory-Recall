import { verifyReleaseReadinessArtifacts } from '../packages/release-readiness/src/index.mjs';

const result = await verifyReleaseReadinessArtifacts(process.cwd());

if (result.drift.length > 0) {
  console.error(`Release readiness artifacts drifted: ${result.drift.join(', ')}`);
  process.exitCode = 1;
} else if (!result.placeholderResult.passed) {
  console.error(`Release readiness placeholder audit failed: ${JSON.stringify(result.placeholderResult.findings, null, 2)}`);
  process.exitCode = 1;
} else {
  console.log('PASS release readiness artifacts verified without drift');
  console.log('PASS release readiness placeholder audit');
}
