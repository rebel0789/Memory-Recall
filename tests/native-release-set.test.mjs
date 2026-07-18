import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  NATIVE_RELEASE_ORDER,
  publishNativePackages,
  validateNativeReleaseSet,
  verifyRegistryRecord
} from '../scripts/native-release-set.mjs';

test('stable npm release requires a signed exact native set before the root package', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-native-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const version = '1.2.0';
  const commit = 'a'.repeat(40);
  const optionalDependencies = {};

  for (const target of NATIVE_RELEASE_ORDER) {
    const packageName = `@memory-recall/native-${target}`;
    optionalDependencies[packageName] = version;
    const directory = path.join(root, target);
    await mkdir(directory, { recursive: true });
    const tarball = `memory-recall-native-${target}-${version}.tgz`;
    const bytes = Buffer.from(`verified-${target}`);
    await writeFile(path.join(directory, tarball), bytes);
    await writeFile(path.join(directory, `native-package-${target}-receipt.json`), `${JSON.stringify({
      schemaVersion: '1.0.0',
      receiptVersion: 'memory-recall-native-distribution-1',
      commit,
      runner: `runner-${target}`,
      target,
      abi: expectedAbi(target),
      package: {
        name: packageName,
        version,
        tarball,
        binarySha256: `sha256:${'b'.repeat(64)}`,
        tarballSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        entryCount: 5,
        size: bytes.length,
        unpackedSize: bytes.length * 2
      },
      consumerGate: {
        command: 'node scripts/native-code-intelligence-consumer-smoke.mjs',
        result: 'pass'
      },
      artifactState: {
        signed: true,
        published: false,
        signature: {
          kind: 'github-sigstore-provenance',
          attestationId: '12345',
          attestationUrl: 'https://github.com/rebel0789/Memory-Recall/attestations/12345'
        }
      }
    }, null, 2)}\n`);
  }

  const rootPackage = { name: 'memory-recall', version, optionalDependencies };
  const releaseSet = await validateNativeReleaseSet({
    artifactsDirectory: root,
    expectedVersion: version,
    expectedCommit: commit,
    rootPackage
  });
  assert.equal(releaseSet.nativePackageCount, 5);
  assert.deepEqual(releaseSet.publishOrder, NATIVE_RELEASE_ORDER.map((target) => `@memory-recall/native-${target}`));
  assert(releaseSet.artifacts.every(({ signed, tarballIntegrity }) => signed && /^sha512-/u.test(tarballIntegrity)));
  verifyRegistryRecord(releaseSet.artifacts[0], {
    version,
    integrity: releaseSet.artifacts[0].tarballIntegrity
  });
  assert.throws(
    () => verifyRegistryRecord(releaseSet.artifacts[0], { version, integrity: 'sha512-wrong' }),
    /integrity does not match/u
  );

  const fakeNpm = path.join(root, 'fake-npm.mjs');
  const fakeState = path.join(root, 'fake-npm-state.json');
  const fakeLog = path.join(root, 'fake-npm-log.jsonl');
  const tarballs = Object.fromEntries(releaseSet.artifacts.map((artifact) => [path.basename(artifact.tarball), {
    packageName: artifact.packageName,
    version: artifact.version,
    integrity: artifact.tarballIntegrity
  }]));
  await writeFile(fakeState, `${JSON.stringify({ records: {}, tarballs })}\n`);
  await writeFile(fakeLog, '');
  await writeFile(fakeNpm, `
    import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
    import path from 'node:path';
    const [command, ...args] = process.argv.slice(2);
    const state = JSON.parse(readFileSync(process.env.FAKE_NPM_STATE, 'utf8'));
    appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ command, args }) + '\\n');
    if (command === 'view') {
      const record = state.records[args[0]];
      if (!record) {
        process.stderr.write('npm error code E404\\n');
        process.exitCode = 1;
      } else {
        process.stdout.write(JSON.stringify({ version: record.version, 'dist.integrity': record.integrity }));
      }
    } else if (command === 'publish') {
      const artifact = state.tarballs[path.basename(args[0])];
      if (!artifact) throw new Error('unknown tarball');
      state.records[artifact.packageName + '@' + artifact.version] = artifact;
      writeFileSync(process.env.FAKE_NPM_STATE, JSON.stringify(state));
      process.stdout.write(JSON.stringify({ id: artifact.packageName + '@' + artifact.version }));
    } else {
      throw new Error('unexpected npm command ' + command);
    }
  `);
  const previousEnvironment = {
    npm_execpath: process.env.npm_execpath,
    FAKE_NPM_STATE: process.env.FAKE_NPM_STATE,
    FAKE_NPM_LOG: process.env.FAKE_NPM_LOG
  };
  Object.assign(process.env, { npm_execpath: fakeNpm, FAKE_NPM_STATE: fakeState, FAKE_NPM_LOG: fakeLog });
  try {
    await publishNativePackages({ releaseSet, artifactsDirectory: root, authMode: 'npm-token' });
    const firstLog = (await readFile(fakeLog, 'utf8')).trim().split('\n').map(JSON.parse);
    const publishes = firstLog.filter(({ command }) => command === 'publish');
    assert.deepEqual(publishes.map(({ args }) => tarballs[path.basename(args[0])].packageName), releaseSet.publishOrder);
    assert(publishes.every(({ args }) => args.includes('--provenance')));
    await writeFile(fakeState, `${JSON.stringify({ records: {}, tarballs })}\n`);
    await publishNativePackages({ releaseSet, artifactsDirectory: root, authMode: 'trusted-publishing' });
    const secondLog = (await readFile(fakeLog, 'utf8')).trim().split('\n').map(JSON.parse);
    const trustedPublishes = secondLog.filter(({ command }) => command === 'publish').slice(5);
    assert.deepEqual(trustedPublishes.map(({ args }) => tarballs[path.basename(args[0])].packageName), releaseSet.publishOrder);
    assert(trustedPublishes.every(({ args }) => !args.includes('--provenance')));
    await publishNativePackages({ releaseSet, artifactsDirectory: root, authMode: 'trusted-publishing' });
    const finalLog = (await readFile(fakeLog, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(finalLog.filter(({ command }) => command === 'publish').length, 10);
    const firstArtifact = releaseSet.artifacts[0];
    await writeFile(fakeState, `${JSON.stringify({
      records: {
        [`${firstArtifact.packageName}@${firstArtifact.version}`]: {
          packageName: firstArtifact.packageName,
          version: firstArtifact.version,
          integrity: 'sha512-wrong'
        }
      },
      tarballs
    })}\n`);
    await writeFile(fakeLog, '');
    await assert.rejects(
      publishNativePackages({ releaseSet, artifactsDirectory: root, authMode: 'trusted-publishing' }),
      /integrity does not match/u
    );
    const failureLog = (await readFile(fakeLog, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(failureLog.map(({ command }) => command), ['view']);
  } finally {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  const firstTarget = NATIVE_RELEASE_ORDER[0];
  const firstReceiptPath = path.join(root, firstTarget, `native-package-${firstTarget}-receipt.json`);
  const firstReceipt = JSON.parse(await readFile(firstReceiptPath, 'utf8'));
  firstReceipt.artifactState.signed = false;
  await writeFile(firstReceiptPath, `${JSON.stringify(firstReceipt, null, 2)}\n`);
  await assert.rejects(
    validateNativeReleaseSet({ artifactsDirectory: root, expectedVersion: version, expectedCommit: commit, rootPackage }),
    /artifact is not signed/u
  );
  firstReceipt.artifactState.signed = true;
  await writeFile(firstReceiptPath, `${JSON.stringify(firstReceipt, null, 2)}\n`);
  await assert.rejects(
    validateNativeReleaseSet({
      artifactsDirectory: root,
      expectedVersion: version,
      expectedCommit: commit,
      rootPackage: { ...rootPackage, optionalDependencies: { ...optionalDependencies, [firstReceipt.package.name]: '1.1.1' } }
    }),
    /must use 1\.2\.0/u
  );

  const workflow = await readFile('.github/workflows/npm-publish.yml', 'utf8');
  const download = workflow.indexOf('Download exact native release artifacts');
  const verifyRun = workflow.indexOf('Verify exact successful Rust workflow run');
  const validate = workflow.indexOf('Validate complete signed native release set');
  const verifyAttestations = workflow.indexOf('Verify native provenance signatures');
  const publishNative = workflow.indexOf('Publish native packages');
  const verifyNative = workflow.indexOf('Verify native packages on npm');
  const dryRunRoot = workflow.indexOf('Dry-run root package after native registry verification');
  const publishRoot = workflow.indexOf('Publish with npm Trusted Publishing');
  assert(verifyRun >= 0 && verifyRun < download && download < validate);
  assert(validate < verifyAttestations && verifyAttestations < publishNative && publishNative < verifyNative);
  assert(verifyNative < dryRunRoot && dryRunRoot < publishRoot);
  assert.match(workflow, /native_run_id:/u);
  assert.match(workflow, /name: memory-recall-native-release-set-\$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /run\.path !== expected\.workflow/u);
  assert.match(workflow, /gh attestation verify/u);
  assert.match(workflow, /--signer-workflow/u);
  assert.match(workflow, /npm@11\.5\.1/u);
  assert.match(workflow, /node scripts\/native-release-set\.mjs validate/u);
  assert.match(workflow, /node scripts\/native-release-set\.mjs publish-native/u);
  assert.match(workflow, /node scripts\/native-release-set\.mjs verify-registry/u);
});

function expectedAbi(target) {
  if (target === 'darwin-arm64') return { platform: 'darwin', arch: 'arm64', libc: null };
  if (target === 'darwin-x64') return { platform: 'darwin', arch: 'x64', libc: null };
  if (target === 'linux-arm64-gnu') return { platform: 'linux', arch: 'arm64', libc: 'glibc' };
  if (target === 'linux-x64-gnu') return { platform: 'linux', arch: 'x64', libc: 'glibc' };
  return { platform: 'win32', arch: 'x64', libc: null };
}
