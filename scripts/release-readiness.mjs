import { writeReleaseReadinessArtifacts } from '../packages/release-readiness/src/index.mjs';

const artifacts = await writeReleaseReadinessArtifacts(process.cwd());

if (!artifacts.placeholderResult.passed) {
  console.error(`Release readiness placeholder audit failed: ${JSON.stringify(artifacts.placeholderResult.findings, null, 2)}`);
  process.exitCode = 1;
} else {
  console.log('PASS release readiness placeholder audit');
}

console.log('PASS release readiness SBOM and provenance generated');
console.log('PASS release readiness reports generated');
console.log(`PASS release readiness public evidence bound: ${artifacts.publicEvidence.map((page) => page.path).join(', ')}`);
