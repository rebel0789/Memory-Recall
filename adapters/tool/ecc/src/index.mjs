import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ContractViolation,
  SkillSourcePort,
  assertCanonicalEnvelope,
  assertPortImplementation,
  createProviderEnvelope,
  normalizeCapabilities,
  normalizeHealthResult
} from '../../../../packages/adapter-contracts/src/index.mjs';

export const ECC_ADAPTER_ID = 'adapter:tool:ecc';
export const ECC_ADAPTER_VERSION = '0.1.0-experimental';
export const ECC_UPSTREAM_COMMIT = '34faa39bd3cd496a0aece0245f2b7e38b7923abc';
export const ECC_ARCHIVE_SHA256 = 'c4a147dfb3766ee4eaedf74efbbc62cb5cdab014a5df98bee67020fb05871ae0';
export const ECC_LICENSE_SPDX = 'MIT';

const CAPABILITIES = Object.freeze(['skills.import-source', 'skills.review-source']);
const MAX_OUTPUT_BYTES = 4096;
const BLOCKED_KEYS = /(^|\.)(body|content|raw|prompt|output|secret|token|cookie|authorization|path|localPath|hiddenReasoning)($|\.)/i;

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function assertNotAborted(signal) {
  if (signal?.aborted) {
    throw new ContractViolation('adapter_cancelled', 'ECC adapter operation was cancelled');
  }
}

async function withinAdapterBoundary(operation, { signal = null, timeoutMs = 1000 } = {}) {
  assertNotAborted(signal);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new ContractViolation('adapter_timeout', 'ECC adapter operation timed out before invocation');
  }
  const controller = new AbortController();
  let timer = null;
  let abortListener = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new ContractViolation('adapter_timeout', 'ECC adapter operation timed out');
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const cancellation = signal ? new Promise((_, reject) => {
    abortListener = () => {
      const error = new ContractViolation('adapter_cancelled', 'ECC adapter operation was cancelled');
      controller.abort(error);
      reject(error);
    };
    signal.addEventListener('abort', abortListener, { once: true });
  }) : new Promise(() => {});
  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  operationPromise.catch(() => {});
  try {
    return await Promise.race([operationPromise, timeout, cancellation]);
  } finally {
    clearTimeout(timer);
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
}

function assertBoundedOutput(value) {
  if (byteLength(value) > MAX_OUTPUT_BYTES) {
    throw new ContractViolation('invalid_provider_output', 'ECC adapter output exceeded the reviewed schema budget');
  }
  return value;
}

function assertNoRawFields(value, prefix = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = prefix ? `${prefix}.${key}` : key;
    if (BLOCKED_KEYS.test(childPath)) {
      throw new ContractViolation('invalid_provider_output', `ECC provider output included blocked field ${childPath}`);
    }
    if (child && typeof child === 'object') assertNoRawFields(child, childPath);
  }
}

function exactGrantAllowed(grant, operation, procedureId) {
  return grant
    && grant.decision === 'allow'
    && grant.adapterId === ECC_ADAPTER_ID
    && grant.operation === operation
    && grant.procedureId === procedureId;
}

function safeProcedure(record, upstream) {
  return Object.freeze({
    id: record.id,
    title: record.title,
    summary: record.summary,
    source: Object.freeze({
      upstreamCommit: upstream.commit,
      archiveSha256: upstream.archiveSha256,
      licenseSpdx: upstream.licenseSpdx,
      sourcePath: record.sourcePath,
      reviewStatus: record.reviewStatus
    }),
    allowedUse: record.allowedUse,
    fingerprint: stableHash({
      id: record.id,
      title: record.title,
      summary: record.summary,
      upstreamCommit: upstream.commit,
      sourcePath: record.sourcePath
    })
  });
}

async function loadReviewedProcedures(url = new URL('../reviewed-procedures.json', import.meta.url), { signal = null } = {}) {
  const data = JSON.parse(await readFile(url, { encoding: 'utf8', signal }));
  if (data.adapterId !== ECC_ADAPTER_ID) {
    throw new ContractViolation('invalid_provider_output', 'reviewed procedure index belongs to another adapter');
  }
  return data;
}

export class EccSkillSourceAdapter extends SkillSourcePort {
  constructor({ procedureIndex = null, installed = true } = {}) {
    super();
    this.procedureIndex = procedureIndex;
    this.installed = installed;
    assertPortImplementation(this, SkillSourcePort);
  }

  async index({ signal = null } = {}) {
    assertNotAborted(signal);
    if (!this.procedureIndex) this.procedureIndex = await loadReviewedProcedures(new URL('../reviewed-procedures.json', import.meta.url), { signal });
    assertNotAborted(signal);
    return this.procedureIndex;
  }

  async health({ installed = this.installed } = {}) {
    return normalizeHealthResult({
      status: installed ? 'healthy' : 'unavailable',
      local: true,
      details: {
        adapterId: ECC_ADAPTER_ID,
        installMode: 'none',
        safe: true,
        enabledByDefault: false,
        upstreamCommit: ECC_UPSTREAM_COMMIT
      }
    }, ECC_ADAPTER_ID);
  }

  async capabilities() {
    return normalizeCapabilities(CAPABILITIES, ECC_ADAPTER_ID);
  }

  async inspect({ procedureId, signal = null, timeoutMs = 1000 } = {}) {
    return withinAdapterBoundary(async (boundarySignal) => {
      const index = await this.index({ signal: boundarySignal });
      const record = index.procedures.find((item) => item.id === procedureId);
      if (!record) throw new ContractViolation('procedure_not_found', `reviewed ECC procedure not found: ${procedureId}`);
      const procedure = safeProcedure(record, index.upstream);
      const envelope = createProviderEnvelope({
        providerId: ECC_ADAPTER_ID,
        operation: 'skills.inspectProcedure',
        upstream: {
          repository: index.upstream.repository,
          commit: index.upstream.commit,
          archiveSha256: index.upstream.archiveSha256,
          licenseSpdx: index.upstream.licenseSpdx
        },
        payload: { procedure }
      });
      assertNoRawFields(envelope.payload);
      return assertBoundedOutput(envelope);
    }, { signal, timeoutMs });
  }

  async importProposal({ procedureId, grant, providerEnvelope = null, signal = null, timeoutMs = 1000 } = {}) {
    return withinAdapterBoundary(async (boundarySignal) => {
      if (!exactGrantAllowed(grant, 'skills.importProposal', procedureId)) {
        throw new ContractViolation('permission_denied', 'ECC import proposal requires an exact reviewed grant');
      }
      const envelope = providerEnvelope
        ? assertCanonicalEnvelope(providerEnvelope, ECC_ADAPTER_ID)
        : await this.inspect({ procedureId, signal: boundarySignal, timeoutMs });
      assertNoRawFields(envelope.payload);
      const procedure = envelope.payload?.procedure;
      if (!procedure?.id || procedure.id !== procedureId || procedure.allowedUse !== 'proposal-only') {
        throw new ContractViolation('invalid_provider_output', 'ECC provider output did not match the reviewed procedure schema');
      }
      const proposal = {
        schemaVersion: '1.0.0',
        adapterId: ECC_ADAPTER_ID,
        status: 'proposal',
        sideEffectClass: 'proposal-only',
        canonicalStateChanged: false,
        procedure: {
          id: procedure.id,
          title: procedure.title,
          summary: procedure.summary,
          fingerprint: procedure.fingerprint
        },
        provenance: {
          upstreamCommit: envelope.upstream?.commit ?? procedure.source?.upstreamCommit,
          archiveSha256: envelope.upstream?.archiveSha256 ?? procedure.source?.archiveSha256,
          licenseSpdx: envelope.upstream?.licenseSpdx ?? procedure.source?.licenseSpdx,
          sourcePath: procedure.source?.sourcePath,
          reviewStatus: procedure.source?.reviewStatus
        }
      };
      return assertBoundedOutput(proposal);
    }, { signal, timeoutMs });
  }
}

export async function runEccConformanceFixture({ fixture, adapter = new EccSkillSourceAdapter() }) {
  const results = [];
  for (const testCase of fixture.cases) {
    try {
      let actual;
      if (testCase.kind === 'health') actual = await adapter.health(testCase.input);
      else if (testCase.kind === 'capabilities') actual = { capabilities: await adapter.capabilities() };
      else if (testCase.kind === 'permission-denied') {
        await adapter.importProposal({ procedureId: 'ecc:procedure:agent-sort-review', grant: testCase.input.grant });
      } else if (testCase.kind === 'malformed-output') {
        const payload = testCase.input.fixture === 'invalid-provider-payload'
          ? { rawPrompt: 'do not persist this', procedure: { id: 'ecc:procedure:agent-sort-review' } }
          : { procedure: { id: 'ecc:procedure:agent-sort-review', title: 'x'.repeat(MAX_OUTPUT_BYTES), allowedUse: 'proposal-only' } };
        await adapter.importProposal({
          procedureId: 'ecc:procedure:agent-sort-review',
          grant: { decision: 'allow', adapterId: ECC_ADAPTER_ID, operation: 'skills.importProposal', procedureId: 'ecc:procedure:agent-sort-review' },
          providerEnvelope: createProviderEnvelope({ providerId: ECC_ADAPTER_ID, operation: 'skills.inspectProcedure', payload })
        });
      } else if (testCase.kind === 'timeout') {
        await adapter.inspect(testCase.input);
      } else if (testCase.kind === 'success') {
        actual = await adapter.importProposal(testCase.input);
      } else {
        throw new ContractViolation('unsupported_fixture_case', `Unsupported ECC fixture case ${testCase.kind}`);
      }
      results.push({ id: testCase.id, passed: true, actual });
    } catch (error) {
      const expectedCode = testCase.expected?.code;
      results.push({
        id: testCase.id,
        passed: error instanceof ContractViolation && error.code === expectedCode,
        actual: {
          code: error.code,
          invoked: false,
          canonicalStateChanged: false
        }
      });
    }
  }
  return {
    adapterId: ECC_ADAPTER_ID,
    contract: SkillSourcePort.contract,
    passed: results.every((result) => result.passed),
    cases: results
  };
}

export function reviewedProcedureIndexPath() {
  return fileURLToPath(new URL('../reviewed-procedures.json', import.meta.url));
}
