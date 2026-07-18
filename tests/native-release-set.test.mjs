import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  auditRegistrySignatures,
  NATIVE_RELEASE_ORDER,
  packageRootRelease,
  publishNativePackages,
  publishRootPackage,
  validateNativeReleaseSet,
  validateRootReleaseArtifact,
  verifyRootRegistry,
  verifyRegistryRecord
} from '../scripts/native-release-set.mjs';
import { buildNativeSpdxSbom, NATIVE_TARGETS } from '../scripts/package-native-platform.mjs';

test('stable npm release requires a signed exact native set before the root package', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-native-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  const commit = 'a'.repeat(40);
  const optionalDependencies = {};

  for (const target of NATIVE_RELEASE_ORDER) {
    const packageName = `@memory-recall/native-${target}`;
    optionalDependencies[packageName] = version;
    const directory = path.join(root, target);
    await mkdir(directory, { recursive: true });
    const tarball = `memory-recall-native-${target}-${version}.tgz`;
    const bytes = Buffer.from(`verified-${target}`);
    const tarballSha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const sbomName = `native-package-${target}.spdx.json`;
    const packageReport = {
      target,
      packageName,
      version,
      files: ['LICENSE', 'NOTICE', NATIVE_TARGETS[target].binary, 'native-manifest.json', 'package.json']
        .map((file, index) => ({
          path: file,
          sha1: String(index + 1).repeat(40),
          sha256: String(index + 1).repeat(64)
        }))
    };
    const sbom = `${JSON.stringify(buildNativeSpdxSbom({
      packageReport,
      commit,
      created: '2026-07-18T00:00:00Z',
      tarballSha256
    }), null, 2)}\n`;
    await writeFile(path.join(directory, tarball), bytes);
    await writeFile(path.join(directory, sbomName), sbom);
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
        tarballSha256,
        sbom: sbomName,
        sbomSha256: `sha256:${createHash('sha256').update(sbom).digest('hex')}`,
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
    integrity: releaseSet.artifacts[0].tarballIntegrity,
    attestations: npmAttestations(releaseSet.artifacts[0].packageName, version)
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
    integrity: artifact.tarballIntegrity,
    attestations: npmAttestations(artifact.packageName, artifact.version)
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
        process.stdout.write(JSON.stringify({ version: record.version, 'dist.integrity': record.integrity, 'dist.attestations': record.attestations }));
      }
    } else if (command === 'publish') {
      const artifact = state.tarballs[path.basename(args[0])];
      if (!artifact) throw new Error('unknown tarball');
      state.records[artifact.packageName + '@' + artifact.version] = artifact;
      writeFileSync(process.env.FAKE_NPM_STATE, JSON.stringify(state));
      process.stdout.write(JSON.stringify({ id: artifact.packageName + '@' + artifact.version }));
    } else if (command === 'install') {
      process.stdout.write('lock created');
    } else if (command === 'audit') {
      const dependencies = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).dependencies;
      const verified = Object.entries(dependencies).map(([name, version]) => ({
        name,
        version,
        attestationBundles: [
          { predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1' },
          ...(process.env.FAKE_NPM_AUDIT_MODE === 'incomplete' ? [] : [{ predicateType: 'https://slsa.dev/provenance/v1' }])
        ]
      }));
      process.stdout.write(JSON.stringify({ invalid: [], missing: [], verified }));
    } else {
      throw new Error('unexpected npm command ' + command);
    }
  `);
  const previousEnvironment = {
    npm_execpath: process.env.npm_execpath,
    FAKE_NPM_STATE: process.env.FAKE_NPM_STATE,
    FAKE_NPM_LOG: process.env.FAKE_NPM_LOG,
    FAKE_NPM_AUDIT_MODE: process.env.FAKE_NPM_AUDIT_MODE
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
    const auditProof = await auditRegistrySignatures(releaseSet.artifacts.map(({ packageName, version: artifactVersion }) => ({
      packageName,
      version: artifactVersion
    })));
    assert.equal(auditProof.verified.length, 5);
    assert.equal(auditProof.requiredPredicates.length, 2);
    const finalLog = (await readFile(fakeLog, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(finalLog.filter(({ command }) => command === 'publish').length, 10);
    assert.deepEqual(finalLog.slice(-2).map(({ command }) => command), ['install', 'audit']);
    const rootBytes = Buffer.from('verified-root-package');
    const rootTarball = `memory-recall-${version}.tgz`;
    await writeFile(path.join(root, rootTarball), rootBytes);
    const rootArtifact = {
      packageName: 'memory-recall',
      version,
      tarball: rootTarball,
      tarballIntegrity: `sha512-${createHash('sha512').update(rootBytes).digest('base64')}`
    };
    tarballs[rootTarball] = {
      packageName: rootArtifact.packageName,
      version,
      integrity: rootArtifact.tarballIntegrity,
      attestations: npmAttestations(rootArtifact.packageName, version)
    };
    const stateBeforeRoot = JSON.parse(await readFile(fakeState, 'utf8'));
    stateBeforeRoot.tarballs = tarballs;
    await writeFile(fakeState, `${JSON.stringify(stateBeforeRoot)}\n`);
    const nativeRecords = Object.fromEntries(releaseSet.artifacts.map((nativeArtifact) => [
      `${nativeArtifact.packageName}@${nativeArtifact.version}`,
      tarballs[path.basename(nativeArtifact.tarball)]
    ]));
    const rootPublishOptions = {
      artifact: rootArtifact,
      artifactsDirectory: root,
      nativeArtifactsDirectory: root,
      expectedVersion: version,
      expectedCommit: commit,
      authMode: 'npm-token'
    };
    const publishRoot = () => publishRootPackage(rootPublishOptions);
    await writeFile(fakeLog, '');
    await assert.rejects(
      publishRootPackage({ ...rootPublishOptions, nativeArtifactsDirectory: undefined }),
      /root publication requires native artifacts directory/u
    );
    assert.equal(await readFile(fakeLog, 'utf8'), '');

    await writeFile(fakeState, `${JSON.stringify({ records: {}, tarballs })}\n`);
    await writeFile(fakeLog, '');
    await assert.rejects(publishRoot(), /registry verification failed/u);
    assert.doesNotMatch(await readFile(fakeLog, 'utf8'), /memory-recall@|"command":"publish"/u);

    const mismatchedRecords = structuredClone(nativeRecords);
    mismatchedRecords[`${releaseSet.artifacts[0].packageName}@${version}`].integrity = 'sha512-wrong';
    await writeFile(fakeState, `${JSON.stringify({ records: mismatchedRecords, tarballs })}\n`);
    await writeFile(fakeLog, '');
    await assert.rejects(publishRoot(), /integrity does not match/u);
    assert.doesNotMatch(await readFile(fakeLog, 'utf8'), /memory-recall@|"command":"publish"/u);

    const unattestedRecords = structuredClone(nativeRecords);
    unattestedRecords[`${releaseSet.artifacts[0].packageName}@${version}`].attestations = {};
    await writeFile(fakeState, `${JSON.stringify({ records: unattestedRecords, tarballs })}\n`);
    await writeFile(fakeLog, '');
    await assert.rejects(publishRoot(), /npm provenance is missing/u);
    assert.doesNotMatch(await readFile(fakeLog, 'utf8'), /memory-recall@|"command":"publish"/u);

    process.env.FAKE_NPM_AUDIT_MODE = 'incomplete';
    await writeFile(fakeState, `${JSON.stringify({ records: nativeRecords, tarballs })}\n`);
    await writeFile(fakeLog, '');
    await assert.rejects(publishRoot(), /attestation bundle is incomplete/u);
    assert.doesNotMatch(await readFile(fakeLog, 'utf8'), /memory-recall@|"command":"publish"/u);
    delete process.env.FAKE_NPM_AUDIT_MODE;

    await writeFile(fakeState, `${JSON.stringify({ records: nativeRecords, tarballs })}\n`);
    await writeFile(fakeLog, '');
    await publishRoot();
    await publishRoot();
    const rootProof = await verifyRootRegistry(rootArtifact);
    assert.deepEqual(rootProof.verified, [`memory-recall@${version}`]);
    const afterRootLog = (await readFile(fakeLog, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(afterRootLog.slice(0, 5).map(({ command, args }) => [command, args[0]]), releaseSet.publishOrder.map(
      (packageName) => ['view', `${packageName}@${version}`]
    ));
    const firstRootLookup = afterRootLog.findIndex(({ command, args }) => command === 'view' && args[0] === `memory-recall@${version}`);
    const firstRootPublish = afterRootLog.findIndex(({ command, args }) => command === 'publish' && path.basename(args[0]) === rootTarball);
    assert(firstRootLookup > 6 && firstRootPublish > firstRootLookup);
    const rootPublishes = afterRootLog.filter(({ command, args }) => command === 'publish' && path.basename(args[0]) === rootTarball);
    assert.equal(rootPublishes.length, 1);
    assert(rootPublishes[0].args.includes('--provenance'));
    process.env.FAKE_NPM_AUDIT_MODE = 'incomplete';
    await assert.rejects(
      auditRegistrySignatures([{ packageName: releaseSet.artifacts[0].packageName, version }]),
      /attestation bundle is incomplete/u
    );
    delete process.env.FAKE_NPM_AUDIT_MODE;
    const firstArtifact = releaseSet.artifacts[0];
    await writeFile(fakeState, `${JSON.stringify({
      records: {
        [`${firstArtifact.packageName}@${firstArtifact.version}`]: {
          packageName: firstArtifact.packageName,
          version: firstArtifact.version,
          integrity: 'sha512-wrong',
          attestations: npmAttestations(firstArtifact.packageName, firstArtifact.version)
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
      rootPackage: { ...rootPackage, optionalDependencies: { ...optionalDependencies, [firstReceipt.package.name]: '9.9.9' } }
    }),
    new RegExp(`must use ${version.replaceAll('.', '\\.')}`, 'u')
  );

  const rootReleaseDirectory = path.join(root, 'root-release');
  const currentPackage = JSON.parse(await readFile('package.json', 'utf8'));
  const rootReceipt = await packageRootRelease({
    outDirectory: rootReleaseDirectory,
    expectedCommit: commit,
    created: '2026-07-18T00:00:00Z'
  });
  assert.equal(rootReceipt.package.name, 'memory-recall');
  assert.equal(rootReceipt.package.version, currentPackage.version);
  assert.equal(rootReceipt.nativePackages.length, 5);
  assert.match(rootReceipt.package.tarballSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.match(rootReceipt.package.tarballIntegrity, /^sha512-/u);
  const rootReleaseArtifact = await validateRootReleaseArtifact({
    artifactsDirectory: rootReleaseDirectory,
    expectedVersion: currentPackage.version,
    expectedCommit: commit
  });
  assert.equal(rootReleaseArtifact.tarball, rootReceipt.package.tarball);
  assert.equal(rootReleaseArtifact.tarballIntegrity, rootReceipt.package.tarballIntegrity);
  const rootSbom = JSON.parse(await readFile(path.join(rootReleaseDirectory, rootReceipt.package.sbom), 'utf8'));
  assert.equal(rootSbom.files.length, rootReceipt.package.entryCount);
  assert.equal(rootSbom.packages[0].filesAnalyzed, true);
  assert.equal(rootSbom.relationships.length, rootReceipt.package.entryCount);
  const rootTarballPath = path.join(rootReleaseDirectory, rootReceipt.package.tarball);
  const rootTarballBytes = await readFile(rootTarballPath);
  await writeFile(rootTarballPath, Buffer.concat([rootTarballBytes, Buffer.from('tampered')]));
  await assert.rejects(
    validateRootReleaseArtifact({
      artifactsDirectory: rootReleaseDirectory,
      expectedVersion: currentPackage.version,
      expectedCommit: commit
    }),
    /checksum or size is invalid/u
  );
  await writeFile(rootTarballPath, rootTarballBytes);
  await writeFile(path.join(rootReleaseDirectory, 'unexpected.tgz'), 'unexpected');
  await assert.rejects(
    validateRootReleaseArtifact({
      artifactsDirectory: rootReleaseDirectory,
      expectedVersion: currentPackage.version,
      expectedCommit: commit
    }),
    /exactly the receipt, SBOM, and tarball/u
  );
  await rm(path.join(rootReleaseDirectory, 'unexpected.tgz'));

  const workflow = await readFile('.github/workflows/npm-publish.yml', 'utf8');
  const download = workflow.indexOf('Download exact native release artifacts');
  const verifyRun = workflow.indexOf('Verify exact successful Rust workflow run');
  const validate = workflow.indexOf('Validate complete signed native release set');
  const verifyAttestations = workflow.indexOf('Verify native provenance signatures');
  const verifySbomAttestations = workflow.indexOf('Verify native SBOM signatures');
  const publishNative = workflow.indexOf('Publish native packages');
  const verifyNative = workflow.indexOf('Verify native packages on npm');
  const dryRunRoot = workflow.indexOf('Dry-run root package after native registry verification');
  const publishRoot = workflow.indexOf('Publish exact root package');
  const verifyRoot = workflow.indexOf('Verify root package on npm');
  assert(verifyRun >= 0 && verifyRun < download && download < validate);
  assert(validate < verifyAttestations && verifyAttestations < verifySbomAttestations);
  assert(verifySbomAttestations < publishNative && publishNative < verifyNative);
  assert(verifyNative < dryRunRoot && dryRunRoot < publishRoot && publishRoot < verifyRoot);
  assert.match(workflow, /native_run_id:/u);
  assert.match(workflow, /name: memory-recall-native-release-set-\$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /run\.path !== expected\.workflow/u);
  assert.match(workflow, /gh attestation verify/u);
  assert.match(workflow, /--signer-workflow/u);
  assert.match(workflow, /--predicate-type https:\/\/spdx\.dev\/Document\/v2\.3/u);
  assert.match(workflow, /npm@11\.18\.0/u);
  assert.match(workflow, /node scripts\/native-release-set\.mjs validate/u);
  assert.match(workflow, /node scripts\/native-release-set\.mjs publish-native/u);
  assert.match(workflow, /node scripts\/native-release-set\.mjs verify-registry/u);
  assert.match(workflow, /node scripts\/native-release-set\.mjs publish-root/u);
  assert.match(workflow, /publish-root --artifacts output\/root-release --native-artifacts output\/native-release/u);
  assert.match(workflow, /node scripts\/native-release-set\.mjs verify-root-registry/u);
  assert.match(workflow, /git status --porcelain --untracked-files=all/u);
  assert.match(workflow, /root-release\.validation\.json/u);
  assert.match(workflow, /native-release\.validation\.json/u);
  assert.equal((workflow.match(/validate-root[^\n]+> output\/root-release\.validation\.json/gu) ?? []).length, 2);
  assert.doesNotMatch(workflow, /find output\/root-release[^\n]*-print -quit/u);
  assert.doesNotMatch(workflow, /find output\/native-release[^\n]*-print -quit/u);
  assert.doesNotMatch(workflow, /run: npm publish --access public(?:\s|$)/u);

  const missingNativeArtifacts = spawnSync(process.execPath, [
    'scripts/native-release-set.mjs', 'publish-root',
    '--artifacts', rootReleaseDirectory,
    '--version', currentPackage.version,
    '--commit', commit,
    '--auth-mode', 'npm-token'
  ], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(missingNativeArtifacts.status, 1);
  assert.match(missingNativeArtifacts.stderr, /publish-root requires native-artifacts/u);
});

function npmAttestations(packageName, version) {
  return {
    url: `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(packageName)}@${version}`,
    provenance: { predicateType: 'https://slsa.dev/provenance/v1' }
  };
}

function expectedAbi(target) {
  if (target === 'darwin-arm64') return { platform: 'darwin', arch: 'arm64', libc: null };
  if (target === 'darwin-x64') return { platform: 'darwin', arch: 'x64', libc: null };
  if (target === 'linux-arm64-gnu') return { platform: 'linux', arch: 'arm64', libc: 'glibc' };
  if (target === 'linux-x64-gnu') return { platform: 'linux', arch: 'x64', libc: 'glibc' };
  return { platform: 'win32', arch: 'x64', libc: null };
}
