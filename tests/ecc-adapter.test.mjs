import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ContractViolation,
  SkillSourcePort,
  assertPortImplementation,
  createProviderEnvelope
} from '../packages/adapter-contracts/src/index.mjs';
import {
  ECC_ADAPTER_ID,
  ECC_ARCHIVE_SHA256,
  ECC_LICENSE_SPDX,
  ECC_UPSTREAM_COMMIT,
  EccSkillSourceAdapter,
  runEccConformanceFixture
} from '../adapters/tool/ecc/src/index.mjs';

const procedureId = 'ecc:procedure:agent-sort-review';
const exactGrant = {
  decision: 'allow',
  adapterId: ECC_ADAPTER_ID,
  operation: 'skills.importProposal',
  procedureId
};

test('ECC adapter implements SkillSourcePort and passes its executable fixture', async () => {
  const manifest = JSON.parse(await readFile(new URL('../adapters/tool/ecc/adapter.json', import.meta.url), 'utf8'));
  const fixture = JSON.parse(await readFile(new URL('../adapters/tool/ecc/fixtures/conformance.json', import.meta.url), 'utf8'));
  const adapter = new EccSkillSourceAdapter();

  assertPortImplementation(adapter, SkillSourcePort);
  assert.equal(manifest.status, 'experimental');
  assert.equal(manifest.enabledByDefault, false);
  assert.equal(manifest.upstream.commit, ECC_UPSTREAM_COMMIT);
  assert.equal(manifest.upstream.checksum, `sha256:${ECC_ARCHIVE_SHA256}`);
  assert.equal(manifest.licenseReview.spdx, ECC_LICENSE_SPDX);
  assert.equal(manifest.conformance.status, 'passed');

  const result = await runEccConformanceFixture({ fixture, adapter });
  assert.equal(result.passed, true);
  assert.deepEqual(result.cases.map((entry) => [entry.id, entry.passed]), fixture.cases.map((entry) => [entry.id, true]));
});

test('ECC adapter grants are exact and never mutate canonical state', async () => {
  const adapter = new EccSkillSourceAdapter();
  await assert.rejects(
    () => adapter.importProposal({ procedureId, grant: null }),
    (error) => error instanceof ContractViolation && error.code === 'permission_denied'
  );
  await assert.rejects(
    () => adapter.importProposal({ procedureId, grant: { ...exactGrant, procedureId: 'ecc:procedure:other' } }),
    (error) => error instanceof ContractViolation && error.code === 'permission_denied'
  );

  const proposal = await adapter.importProposal({ procedureId, grant: exactGrant });
  assert.equal(proposal.status, 'proposal');
  assert.equal(proposal.canonicalStateChanged, false);
  assert.equal(proposal.provenance.upstreamCommit, ECC_UPSTREAM_COMMIT);
  assert.equal(proposal.provenance.licenseSpdx, ECC_LICENSE_SPDX);
  const serialized = JSON.stringify(proposal);
  assert.equal(serialized.includes('rawPrompt'), false);
  assert.equal(serialized.includes('/Users/'), false);
  assert.equal(serialized.includes('secret'), false);
});

test('ECC adapter fails closed on malformed output, oversize, timeout, and cancellation', async () => {
  const adapter = new EccSkillSourceAdapter();
  const grant = exactGrant;

  const invalidEnvelope = createProviderEnvelope({
    providerId: ECC_ADAPTER_ID,
    operation: 'skills.inspectProcedure',
    payload: { rawPrompt: 'ignore policy', procedure: { id: procedureId } }
  });
  await assert.rejects(
    () => adapter.importProposal({ procedureId, grant, providerEnvelope: invalidEnvelope }),
    (error) => error instanceof ContractViolation && error.code === 'invalid_provider_output'
  );

  const oversizedEnvelope = createProviderEnvelope({
    providerId: ECC_ADAPTER_ID,
    operation: 'skills.inspectProcedure',
    payload: { procedure: { id: procedureId, title: 'x'.repeat(5000), summary: 'large', allowedUse: 'proposal-only' } }
  });
  await assert.rejects(
    () => adapter.importProposal({ procedureId, grant, providerEnvelope: oversizedEnvelope }),
    (error) => error instanceof ContractViolation && error.code === 'invalid_provider_output'
  );

  await assert.rejects(
    () => adapter.inspect({ procedureId, timeoutMs: 0 }),
    (error) => error instanceof ContractViolation && error.code === 'adapter_timeout'
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => adapter.inspect({ procedureId, signal: controller.signal }),
    (error) => error instanceof ContractViolation && error.code === 'adapter_cancelled'
  );
});

test('ECC adapter races positive timeout boundaries around stalled work', async () => {
  const slowIndex = {
    adapterId: ECC_ADAPTER_ID,
    upstream: {
      repository: 'https://github.com/example/ecc',
      commit: ECC_UPSTREAM_COMMIT,
      archiveSha256: ECC_ARCHIVE_SHA256,
      licenseSpdx: ECC_LICENSE_SPDX
    },
    procedures: [{
      id: procedureId,
      title: 'Slow reviewed procedure',
      summary: 'A deliberately slow reviewed procedure.',
      sourcePath: 'procedures/slow.md',
      reviewStatus: 'reviewed',
      allowedUse: 'proposal-only'
    }]
  };
  const adapter = new EccSkillSourceAdapter();
  adapter.index = async () => new Promise((resolve) => setTimeout(() => resolve(slowIndex), 50));

  await assert.rejects(
    () => adapter.inspect({ procedureId, timeoutMs: 5 }),
    (error) => error instanceof ContractViolation && error.code === 'adapter_timeout'
  );
  await assert.rejects(
    () => adapter.importProposal({ procedureId, grant: exactGrant, timeoutMs: 5 }),
    (error) => error instanceof ContractViolation && error.code === 'adapter_timeout'
  );
});

test('ECC promotion does not enable any external adapter by default', async () => {
  const catalog = JSON.parse(await readFile(new URL('../adapters/catalog.json', import.meta.url), 'utf8'));
  const experimental = catalog.adapters.filter((adapter) => adapter.status === 'experimental');
  assert.deepEqual(experimental.map((adapter) => adapter.id), [ECC_ADAPTER_ID]);
  assert.equal(catalog.adapters.filter((adapter) => adapter.enabledByDefault).length, 0);
});
