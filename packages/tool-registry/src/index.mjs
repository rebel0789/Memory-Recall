import { createHash, randomBytes as cryptoRandomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createEvent } from '../../protocol/src/index.mjs';
import { assertJsonSchema, validateJsonSchema } from '../../protocol/src/schema-validator.mjs';
import { canonicalOperationFingerprint, createPolicyService } from '../../policy/src/index.mjs';
import { createTelemetry, toolSpanAttributes } from '../../observability/src/index.mjs';

export const BROKERED_LOCAL_TOOL_PROVIDER_ID = 'provider:native:tool:brokered-local';

export const TOOL_ERROR_CODES = Object.freeze([
  'tool_not_registered',
  'tool_disabled',
  'tool_manifest_invalid',
  'tool_manifest_checksum_mismatch',
  'tool_operation_not_declared',
  'tool_trusted_context_required',
  'tool_request_invalid',
  'tool_input_schema_failed',
  'tool_policy_denied',
  'tool_approval_required',
  'tool_approval_invalid',
  'tool_idempotency_required',
  'tool_grant_invalid',
  'tool_grant_expired',
  'tool_grant_consumed',
  'tool_grant_binding_mismatch',
  'tool_sandbox_unavailable',
  'tool_filesystem_denied',
  'tool_network_denied',
  'tool_secret_denied',
  'tool_timeout',
  'tool_cancelled',
  'tool_output_too_large',
  'tool_output_schema_failed',
  'tool_effect_boundary_required',
  'tool_idempotency_conflict',
  'tool_execution_failed'
]);

const CATALOG_KEYS = new Set(['schemaVersion', 'entries']);
const CATALOG_ENTRY_KEYS = new Set(['toolId', 'manifestPath', 'sha256', 'enabled', 'handlerBindingId', 'reviewStatus', 'reviewVersion', 'disabledReason']);
const MANIFEST_KEYS = new Set(['schemaVersion', 'contractVersion', 'id', 'name', 'version', 'handlerBindingId', 'operations']);
const OPERATION_KEYS = new Set(['sideEffectClass', 'inputSchema', 'outputSchema', 'filesystem', 'network', 'secretReferences', 'dataClasses', 'sandbox', 'limits', 'approval', 'idempotency']);
const FILESYSTEM_KEYS = new Set(['read', 'write']);
const NETWORK_KEYS = new Set(['protocol', 'host', 'port', 'methods', 'consequence', 'locality']);
const LIMIT_KEYS = new Set(['runtimeMs', 'inputBytes', 'outputBytes', 'memoryBytes', 'invocationCount', 'costUnits', 'retryCount']);
const APPROVAL_KEYS = new Set(['required']);
const IDEMPOTENCY_KEYS = new Set(['required']);
const REQUEST_KEYS = new Set([
  'schemaVersion',
  'requestId',
  'correlationId',
  'workspaceId',
  'runId',
  'stepId',
  'actorId',
  'trustedContext',
  'toolId',
  'toolVersion',
  'manifestFingerprint',
  'operation',
  'input',
  'requestedCapability',
  'dataClass',
  'approvalContext',
  'idempotencyKey',
  'effectBoundary',
  'timeoutMs',
  'outputLimitBytes',
  'trustedTimestamp',
  'signal',
  'secretResolver'
]);

const FORGED_AUTHORITY_KEYS = new Set([
  'role',
  'isOwner',
  'policyOutcome',
  'externalWritesEnabled',
  'allowedPaths',
  'allowedDomains',
  'secretValues',
  'sandboxProfile',
  'approvalValid'
]);

const SANDBOX_PROFILES = new Set(['pure-local', 'brokered-filesystem-read', 'brokered-filesystem-write', 'brokered-loopback-http', 'brokered-secret-reference']);
const DEFAULT_LIMITS = Object.freeze({
  catalogBytes: 256 * 1024,
  manifestBytes: 128 * 1024,
  inputBytes: 64 * 1024,
  outputBytes: 64 * 1024,
  runtimeMs: 30_000,
  grantTtlMs: 30_000,
  pathBytes: 240,
  readBytes: 64 * 1024,
  writeBytes: 64 * 1024,
  networkResponseBytes: 64 * 1024
});

function toolError(code, message = code, details = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.details = details;
  return error;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

export function stableToolFingerprint(value) {
  return `sha256:${sha256(stable(value))}`;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw toolError('tool_request_invalid', `${label} must be an object`);
  return value;
}

function assertNoUnknown(object, allowed, label, code = 'tool_request_invalid') {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw toolError(code, `${label} unknown field: ${key}`);
  }
}

function assertNoForgedAuthority(object) {
  for (const key of Object.keys(object ?? {})) {
    if (FORGED_AUTHORITY_KEYS.has(key)) throw toolError('tool_request_invalid', `caller-supplied authority is not accepted: ${key}`);
  }
}

function boundedJsonBytes(value, limit, code = 'tool_request_invalid') {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > limit) throw toolError(code, `payload exceeds ${limit} bytes`, { bytes, limit });
  return bytes;
}

function safeClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function readBoundedFile(file, limit, code) {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size > limit) throw toolError(code, `file exceeds ${limit} bytes`);
    const data = await handle.readFile();
    if (data.length > limit) throw toolError(code, `file exceeds ${limit} bytes`);
    return data;
  } finally {
    await handle.close();
  }
}

function validateSchemaSubset(schema, label) {
  try {
    validateJsonSchema(schema, {});
  } catch (error) {
    if (error.code === 'unsupported_schema_keyword') throw toolError('tool_manifest_invalid', `${label} uses unsupported JSON Schema keyword`);
  }
}

function validateFilesystemShape(value, label) {
  assertPlainObject(value, label);
  assertNoUnknown(value, FILESYSTEM_KEYS, label, 'tool_manifest_invalid');
  for (const key of ['read', 'write']) {
    if (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== 'string' || item.length > 256 || !item.startsWith('workspace:'))) {
      throw toolError('tool_manifest_invalid', `${label}.${key} must be bounded workspace scopes`);
    }
  }
}

function validateNetworkShape(value, label) {
  if (!Array.isArray(value) || value.length > 16) throw toolError('tool_manifest_invalid', `${label} must be bounded array`);
  for (const item of value) {
    assertPlainObject(item, label);
    assertNoUnknown(item, NETWORK_KEYS, label, 'tool_manifest_invalid');
    if (!['http', 'https'].includes(item.protocol) || typeof item.host !== 'string' || !Number.isInteger(item.port)) throw toolError('tool_manifest_invalid', 'invalid network destination');
    if (!Array.isArray(item.methods) || item.methods.some((method) => !['GET', 'HEAD'].includes(method))) throw toolError('tool_manifest_invalid', 'invalid network methods');
    if (!['read', 'write'].includes(item.consequence) || !['loopback', 'external'].includes(item.locality)) throw toolError('tool_manifest_invalid', 'invalid network consequence/locality');
  }
}

function validateOperation(operation, label) {
  assertPlainObject(operation, label);
  assertNoUnknown(operation, OPERATION_KEYS, label, 'tool_manifest_invalid');
  if (!['read-only', 'reversible-write', 'consequential-write'].includes(operation.sideEffectClass)) throw toolError('tool_manifest_invalid', 'invalid side-effect class');
  if (!SANDBOX_PROFILES.has(operation.sandbox)) throw toolError('tool_manifest_invalid', 'unsupported sandbox profile');
  validateSchemaSubset(operation.inputSchema, `${label}.inputSchema`);
  validateSchemaSubset(operation.outputSchema, `${label}.outputSchema`);
  validateFilesystemShape(operation.filesystem, `${label}.filesystem`);
  validateNetworkShape(operation.network ?? [], `${label}.network`);
  if (!Array.isArray(operation.secretReferences) || operation.secretReferences.some((ref) => !/^secret:[A-Za-z0-9_.:-]{1,120}$/.test(ref))) throw toolError('tool_manifest_invalid', 'invalid secret references');
  if (!Array.isArray(operation.dataClasses) || operation.dataClasses.some((item) => !['public', 'workspace-private', 'confidential', 'secret'].includes(item))) throw toolError('tool_manifest_invalid', 'invalid data classes');
  assertPlainObject(operation.limits, `${label}.limits`);
  assertNoUnknown(operation.limits, LIMIT_KEYS, `${label}.limits`, 'tool_manifest_invalid');
  assertPlainObject(operation.approval, `${label}.approval`);
  assertNoUnknown(operation.approval, APPROVAL_KEYS, `${label}.approval`, 'tool_manifest_invalid');
  assertPlainObject(operation.idempotency, `${label}.idempotency`);
  assertNoUnknown(operation.idempotency, IDEMPOTENCY_KEYS, `${label}.idempotency`, 'tool_manifest_invalid');
}

export function validateReviewedToolManifest(manifest) {
  assertPlainObject(manifest, 'tool manifest');
  assertNoUnknown(manifest, MANIFEST_KEYS, 'tool manifest', 'tool_manifest_invalid');
  if (manifest.schemaVersion !== '1.1.0' || manifest.contractVersion !== '1.0.0') throw toolError('tool_manifest_invalid', 'unsupported manifest version');
  if (!/^tool:[a-z0-9_.:-]{1,120}$/.test(manifest.id)) throw toolError('tool_manifest_invalid', 'invalid tool id');
  if (typeof manifest.name !== 'string' || !manifest.name || typeof manifest.version !== 'string' || !manifest.version) throw toolError('tool_manifest_invalid', 'invalid name/version');
  if (typeof manifest.handlerBindingId !== 'string' || !manifest.handlerBindingId.startsWith('handler:')) throw toolError('tool_manifest_invalid', 'invalid handler binding');
  assertPlainObject(manifest.operations, 'tool operations');
  const operationNames = Object.keys(manifest.operations);
  if (!operationNames.length || operationNames.length > 16) throw toolError('tool_manifest_invalid', 'manifest requires bounded operations');
  for (const name of operationNames) {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(name)) throw toolError('tool_manifest_invalid', 'invalid operation name');
    validateOperation(manifest.operations[name], `operation.${name}`);
  }
  return manifest;
}

function catalogEntryCheck(entry) {
  assertPlainObject(entry, 'tool catalog entry');
  assertNoUnknown(entry, CATALOG_ENTRY_KEYS, 'tool catalog entry', 'tool_manifest_invalid');
  if (!/^tool:[a-z0-9_.:-]{1,120}$/.test(entry.toolId)) throw toolError('tool_manifest_invalid', 'invalid catalog tool id');
  if (typeof entry.manifestPath !== 'string' || !entry.manifestPath || path.isAbsolute(entry.manifestPath) || entry.manifestPath.includes('..') || entry.manifestPath.includes('\\') || /[\u0000-\u001f\u007f]/u.test(entry.manifestPath)) {
    throw toolError('tool_manifest_invalid', 'invalid catalog manifest path');
  }
  if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw toolError('tool_manifest_invalid', 'invalid manifest checksum');
  if (typeof entry.enabled !== 'boolean') throw toolError('tool_manifest_invalid', 'catalog enabled must be boolean');
  if (typeof entry.handlerBindingId !== 'string' || !entry.handlerBindingId.startsWith('handler:')) throw toolError('tool_manifest_invalid', 'invalid catalog handler binding');
  if (entry.reviewStatus !== 'reviewed' && entry.reviewStatus !== 'disabled') throw toolError('tool_manifest_invalid', 'invalid review status');
  if (typeof entry.reviewVersion !== 'string' || !entry.reviewVersion) throw toolError('tool_manifest_invalid', 'review version required');
}

export async function loadReviewedToolCatalog({ catalogPath, manifestRoot, limits = {} }) {
  const bounded = { ...DEFAULT_LIMITS, ...limits };
  const root = path.resolve(manifestRoot);
  const rootReal = await realpath(root);
  const catalogReal = await realpath(path.resolve(catalogPath));
  if (!catalogReal.startsWith(`${rootReal}${path.sep}`) && path.dirname(catalogReal) !== rootReal) throw toolError('tool_manifest_invalid', 'catalog path escapes manifest root');
  const catalogBytes = await readBoundedFile(catalogReal, bounded.catalogBytes, 'tool_manifest_invalid');
  let catalog;
  try { catalog = JSON.parse(catalogBytes.toString('utf8')); } catch { throw toolError('tool_manifest_invalid', 'catalog JSON is invalid'); }
  assertPlainObject(catalog, 'tool catalog');
  assertNoUnknown(catalog, CATALOG_KEYS, 'tool catalog', 'tool_manifest_invalid');
  if (catalog.schemaVersion !== '1.0.0' || !Array.isArray(catalog.entries)) throw toolError('tool_manifest_invalid', 'unsupported catalog');
  const seenTools = new Set();
  const seenVersions = new Set();
  const seenBindings = new Set();
  const tools = [];
  for (const entry of catalog.entries) {
    catalogEntryCheck(entry);
    const versionKey = `${entry.toolId}:${entry.manifestPath}`;
    if (seenTools.has(entry.toolId) || seenVersions.has(versionKey)) throw toolError('tool_manifest_invalid', 'duplicate tool entry');
    seenTools.add(entry.toolId);
    seenVersions.add(versionKey);
    if (entry.enabled) {
      if (seenBindings.has(entry.handlerBindingId)) throw toolError('tool_manifest_invalid', 'duplicate enabled handler binding');
      seenBindings.add(entry.handlerBindingId);
    }
    const manifestPath = path.resolve(rootReal, entry.manifestPath);
    const manifestReal = await realpath(manifestPath);
    if (!manifestReal.startsWith(`${rootReal}${path.sep}`)) throw toolError('tool_manifest_invalid', 'manifest path escapes root');
    const manifestBytes = await readBoundedFile(manifestReal, bounded.manifestBytes, 'tool_manifest_invalid');
    const actual = sha256(manifestBytes);
    if (actual !== entry.sha256) throw toolError('tool_manifest_checksum_mismatch', 'manifest checksum mismatch');
    let manifest;
    try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { throw toolError('tool_manifest_invalid', 'manifest JSON is invalid'); }
    validateReviewedToolManifest(manifest);
    if (manifest.id !== entry.toolId || manifest.handlerBindingId !== entry.handlerBindingId) throw toolError('tool_manifest_invalid', 'catalog and manifest identity mismatch');
    tools.push({
      entry: safeClone(entry),
      manifest,
      manifestFingerprint: stableToolFingerprint(manifest),
      enabled: entry.enabled
    });
  }
  const byId = new Map(tools.map((tool) => [tool.manifest.id, tool]));
  return Object.freeze({
    schemaVersion: '1.0.0',
    tools: Object.freeze(tools),
    get(id) { return byId.get(id) ?? null; }
  });
}

export class ToolGrantService {
  #grants = new Map();
  constructor({
    clock = () => new Date().toISOString(),
    randomBytes = cryptoRandomBytes,
    grantIdFactory = () => `grant_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  } = {}) {
    this.clock = clock;
    this.randomBytes = randomBytes;
    this.grantIdFactory = grantIdFactory;
  }

  issue({ binding, ttlMs = DEFAULT_LIMITS.grantTtlMs, maxUses = 1 }) {
    assertPlainObject(binding, 'grant binding');
    const grantId = this.grantIdFactory();
    if (!/^grant_[A-Za-z0-9._:-]{1,120}$/.test(grantId)) throw toolError('tool_grant_invalid', 'invalid grant id');
    const secret = this.randomBytes(32).toString('hex');
    const tokenHash = `sha256:${sha256(secret)}`;
    const now = this.clock();
    const expiresAt = new Date(Date.parse(now) + Math.max(1, Math.min(DEFAULT_LIMITS.grantTtlMs, ttlMs))).toISOString();
    const record = Object.freeze({
      schemaVersion: '1.0.0',
      grantId,
      status: 'issued',
      binding: safeClone(binding),
      issuedAt: now,
      expiresAt,
      maxUses,
      uses: 0
    });
    this.#grants.set(grantId, { ...record, tokenHash });
    return { token: `${grantId}.${secret}`, record };
  }

  inspect(grantId) {
    const grant = this.#grants.get(grantId);
    return grant ? safeClone(grant) : null;
  }

  revoke(grantId) {
    const grant = this.#grants.get(grantId);
    if (grant) grant.status = 'revoked';
  }

  consume(token, binding) {
    if (typeof token !== 'string' || !token.includes('.')) return { status: 'failed', code: 'tool_grant_invalid' };
    const [grantId, secret] = token.split('.', 2);
    const grant = this.#grants.get(grantId);
    if (!grant || grant.status === 'revoked') return { status: 'failed', code: 'tool_grant_invalid' };
    const expected = Buffer.from(grant.tokenHash.slice('sha256:'.length), 'hex');
    const actual = Buffer.from(sha256(secret), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { status: 'failed', code: 'tool_grant_invalid' };
    if (Date.parse(grant.expiresAt) <= Date.parse(this.clock())) {
      grant.status = 'expired';
      return { status: 'failed', code: 'tool_grant_expired' };
    }
    if (grant.status === 'consumed' || grant.uses >= grant.maxUses) return { status: 'failed', code: 'tool_grant_consumed' };
    if (stable(grant.binding) !== stable(binding)) return { status: 'failed', code: 'tool_grant_binding_mismatch' };
    grant.status = 'consumed';
    grant.uses += 1;
    return {
      status: 'consumed',
      record: Object.freeze({
        schemaVersion: grant.schemaVersion,
        grantId: grant.grantId,
        status: grant.status,
        binding: safeClone(grant.binding),
        issuedAt: grant.issuedAt,
        expiresAt: grant.expiresAt,
        maxUses: grant.maxUses,
        uses: grant.uses
      })
    };
  }
}

export function createMemoryEffectBoundary() {
  const records = new Map();
  return {
    async effect({ idempotencyKey, operationFingerprint, execute }) {
      if (!idempotencyKey) throw toolError('tool_idempotency_required', 'idempotency key is required');
      if (!operationFingerprint) throw toolError('tool_effect_boundary_required', 'operation fingerprint is required');
      const existing = records.get(idempotencyKey);
      if (existing) {
        if (existing.operationFingerprint !== operationFingerprint) throw toolError('tool_idempotency_conflict', 'idempotency fingerprint conflict');
        return { ...safeClone(existing.output), idempotent: true };
      }
      const output = await execute();
      records.set(idempotencyKey, { operationFingerprint, output: safeClone(output) });
      return { ...safeClone(output), idempotent: false };
    },
    count() { return records.size; }
  };
}

function operationToPolicyManifest(tool, operationName = null) {
  const operations = {};
  for (const [name, operation] of Object.entries(tool.manifest.operations)) {
    operations[name] = {
      sideEffectClass: operation.sideEffectClass,
      filesystem: operation.filesystem,
      network: operation.network,
      secretReferences: operation.secretReferences,
      dataClasses: operation.dataClasses,
      sandbox: operation.sandbox,
      limits: operation.limits
    };
  }
  return {
    id: tool.manifest.id,
    riskClass: operationName ? tool.manifest.operations[operationName]?.sideEffectClass : Object.values(tool.manifest.operations)[0]?.sideEffectClass,
    operations
  };
}

function operationCapability({ tool, operationName, requestedCapability = null, timeoutMs = null, outputLimitBytes = null }) {
  const operation = tool.manifest.operations[operationName];
  const limits = {
    ...operation.limits,
    ...(timeoutMs !== null && timeoutMs !== undefined ? { runtimeMs: timeoutMs } : {}),
    ...(outputLimitBytes !== null && outputLimitBytes !== undefined ? { outputBytes: outputLimitBytes } : {})
  };
  const capability = requestedCapability ?? {
    toolId: tool.manifest.id,
    operation: operationName,
    sideEffectClass: operation.sideEffectClass,
    filesystem: operation.filesystem,
    network: operation.network,
    secretReferences: operation.secretReferences,
    dataClasses: operation.dataClasses,
    sandbox: operation.sandbox,
    limits
  };
  return {
    ...capability,
    limits: { ...capability.limits, ...limits }
  };
}

function assertTrustedContext(request) {
  if (!request.trustedContext) throw toolError('tool_trusted_context_required', 'trusted invocation context is required');
  const { principal, membership, environment } = request.trustedContext;
  if (!principal?.userId || !membership?.workspaceId || membership.status !== 'active' || !environment) {
    throw toolError('tool_trusted_context_required', 'trusted principal, membership, and environment are required');
  }
  return { principal, membership, environment: { ...environment, externalWritesEnabled: false } };
}

function validateInvocation(request) {
  assertPlainObject(request, 'tool invocation');
  assertNoUnknown(request, REQUEST_KEYS, 'tool invocation');
  assertNoForgedAuthority(request);
  if (request.schemaVersion !== '1.0.0') throw toolError('tool_request_invalid', 'unsupported invocation schema');
  for (const key of ['requestId', 'correlationId', 'workspaceId', 'runId', 'stepId', 'actorId', 'toolId', 'toolVersion', 'operation', 'trustedTimestamp']) {
    if (typeof request[key] !== 'string' || !request[key]) throw toolError('tool_request_invalid', `${key} is required`);
  }
  if (Object.hasOwn(request.input ?? {}, 'secretValues')) throw toolError('tool_request_invalid', 'raw secret values are not accepted');
}

function safeEventPayload(payload) {
  const text = JSON.stringify(payload);
  if (text.length > 8192) return { truncated: true };
  return payload;
}

function sanitizeError(error) {
  const code = TOOL_ERROR_CODES.includes(error?.code) ? error.code : 'tool_execution_failed';
  return { code, message: code };
}

function inputFingerprint(input) {
  return stableToolFingerprint(input ?? {});
}

function idempotencyFingerprint(key) {
  return key ? stableToolFingerprint({ idempotencyKey: key }) : null;
}

function approvalFingerprint(approval) {
  return approval ? stableToolFingerprint(approval) : null;
}

function assertNoCallerApprovalAuthority(approval) {
  for (const key of ['serverVerified', 'verifiedBy', 'approvalRecordFingerprint']) {
    if (Object.hasOwn(approval ?? {}, key)) throw toolError('tool_approval_invalid', `caller-supplied approval authority is not accepted: ${key}`);
  }
}

function exactBinding({ request, tool, operationName, capability, policy, operationFingerprint }) {
  return {
    actorId: request.actorId,
    workspaceId: request.workspaceId,
    runId: request.runId,
    stepId: request.stepId,
    toolId: tool.manifest.id,
    toolVersion: tool.manifest.version,
    manifestFingerprint: tool.manifestFingerprint,
    operation: operationName,
    inputFingerprint: inputFingerprint(request.input),
    effectiveCapabilityFingerprint: stableToolFingerprint(policy.effectiveCapability),
    policyDecisionId: policy.decisionId,
    policyVersion: policy.policyVersion,
    policyFingerprint: policy.policyFingerprint,
    operationFingerprint,
    approvalFingerprint: approvalFingerprint(request.approvalContext),
    idempotencyFingerprint: idempotencyFingerprint(request.idempotencyKey)
  };
}

function noSecretLeak(output, values) {
  const text = JSON.stringify(output);
  for (const value of values) {
    if (value && text.includes(value)) throw toolError('tool_secret_denied', 'secret value appeared in output');
  }
}

async function withDeadline({ run, timeoutMs, signal, onAbort }) {
  if (signal?.aborted) throw toolError('tool_cancelled', 'tool invocation was cancelled');
  const controller = new AbortController();
  let timer;
  let abortListener;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = toolError('tool_timeout', 'tool invocation timed out');
      controller.abort(error);
      onAbort?.();
      reject(error);
    }, timeoutMs);
  });
  const cancellation = signal ? new Promise((_, reject) => {
    abortListener = () => {
      const error = toolError('tool_cancelled', 'tool invocation was cancelled');
      controller.abort(error);
      onAbort?.();
      reject(error);
    };
    signal.addEventListener('abort', abortListener, { once: true });
  }) : new Promise(() => {});
  try {
    return await Promise.race([run(controller.signal), timeout, cancellation]);
  } finally {
    clearTimeout(timer);
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
}

class WorkspaceFilesystemBroker {
  constructor({ root, readBytes = DEFAULT_LIMITS.readBytes, writeBytes = DEFAULT_LIMITS.writeBytes, signal, isActive }) {
    this.root = path.resolve(root);
    this.readBytes = readBytes;
    this.writeBytes = writeBytes;
    this.signal = signal;
    this.isActive = isActive;
  }
  #checkActive() {
    if (this.signal?.aborted || this.isActive?.() === false) throw toolError('tool_cancelled', 'tool invocation cancelled');
  }
  #validateRelative(inputPath) {
    if (typeof inputPath !== 'string' || !inputPath || inputPath.length > DEFAULT_LIMITS.pathBytes) throw toolError('tool_filesystem_denied', 'invalid workspace path');
    if (path.isAbsolute(inputPath) || inputPath.startsWith('file:') || inputPath.includes('..') || inputPath.includes('\\') || /[\u0000-\u001f\u007f]/u.test(inputPath)) {
      throw toolError('tool_filesystem_denied', 'invalid workspace path');
    }
    if (inputPath.split('/').some((part) => part === '.' || part === '..' || !part)) throw toolError('tool_filesystem_denied', 'invalid workspace path');
    if (inputPath === '.env' || inputPath.startsWith('.env/') || inputPath.startsWith('.local/') || inputPath.includes('/.env') || inputPath.includes('/.local/')) {
      throw toolError('tool_filesystem_denied', 'control or secret file denied');
    }
    return inputPath;
  }
  async #resolve(inputPath, mustExist = true) {
    const relative = this.#validateRelative(inputPath);
    const candidate = path.resolve(this.root, relative);
    if (!candidate.startsWith(`${this.root}${path.sep}`)) throw toolError('tool_filesystem_denied', 'path escapes workspace');
    if (!mustExist) return { relative, absolute: candidate };
    const resolvedRoot = await realpath(this.root);
    const resolved = await realpath(candidate);
    if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw toolError('tool_filesystem_denied', 'symlink escapes workspace');
    return { relative, absolute: resolved };
  }
  async #assertWriteParentInside(parent) {
    const resolvedRoot = await realpath(this.root);
    let cursor = parent;
    while (true) {
      try {
        await lstat(cursor);
        const resolved = await realpath(cursor);
        if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
          throw toolError('tool_filesystem_denied', 'symlink escapes workspace');
        }
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const next = path.dirname(cursor);
        if (next === cursor) throw toolError('tool_filesystem_denied', 'path escapes workspace');
        cursor = next;
      }
    }
  }
  async readText(inputPath) {
    this.#checkActive();
    const { relative, absolute } = await this.#resolve(inputPath, true);
    const info = await stat(absolute);
    if (!info.isFile() || info.size > this.readBytes) throw toolError('tool_filesystem_denied', 'file read denied');
    const body = await readFile(absolute, 'utf8');
    this.#checkActive();
    return { path: relative, body, sha256: `sha256:${sha256(body)}`, byteSize: Buffer.byteLength(body, 'utf8') };
  }
  async writeText(inputPath, content) {
    this.#checkActive();
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > this.writeBytes) throw toolError('tool_filesystem_denied', 'write content denied');
    const { relative, absolute } = await this.#resolve(inputPath, false);
    await mkdir(this.root, { recursive: true });
    await this.#assertWriteParentInside(path.dirname(absolute));
    await mkdir(path.dirname(absolute), { recursive: true });
    await this.#assertWriteParentInside(path.dirname(absolute));
    const temp = `${absolute}.tmp-${randomUUID()}`;
    await writeFile(temp, content, { mode: 0o600 });
    this.#checkActive();
    await rename(temp, absolute);
    return { path: relative, sha256: `sha256:${sha256(content)}`, byteSize: Buffer.byteLength(content, 'utf8') };
  }
}

class LoopbackEgressBroker {
  constructor({ operation, signal, isActive }) {
    this.operation = operation;
    this.signal = signal;
    this.isActive = isActive;
  }
  #checkActive() {
    if (this.signal?.aborted || this.isActive?.() === false) throw toolError('tool_cancelled', 'tool invocation cancelled');
  }
  async fetchText({ url, method = 'GET' }) {
    this.#checkActive();
    let parsed;
    try { parsed = new URL(url); } catch { throw toolError('tool_network_denied', 'invalid URL'); }
    if (parsed.username || parsed.password || parsed.search.length > 256 || !['http:', 'https:'].includes(parsed.protocol)) throw toolError('tool_network_denied', 'URL denied');
    const destination = {
      protocol: parsed.protocol.slice(0, -1),
      host: parsed.hostname,
      port: Number(parsed.port || (parsed.protocol === 'http:' ? 80 : 443)),
      methods: [method],
      consequence: 'read',
      locality: ['127.0.0.1', 'localhost'].includes(parsed.hostname) ? 'loopback' : 'external'
    };
    const allowed = this.operation.network.some((item) => networkContains(item, destination));
    if (!allowed || destination.locality !== 'loopback') throw toolError('tool_network_denied', 'network destination denied');
    const response = await fetch(parsed, {
      method,
      redirect: 'manual',
      signal: this.signal,
      headers: { accept: 'text/plain, application/json;q=0.5' }
    });
    if (response.status >= 300 && response.status < 400) throw toolError('tool_network_denied', 'redirect denied');
    const text = await boundedResponseText(response, DEFAULT_LIMITS.networkResponseBytes);
    this.#checkActive();
    return {
      status: response.status,
      bodySha256: `sha256:${sha256(text)}`,
      byteSize: Buffer.byteLength(text, 'utf8'),
      headers: Object.fromEntries([...response.headers.entries()].filter(([key]) => !['set-cookie', 'authorization', 'cookie'].includes(key.toLowerCase())).slice(0, 8))
    };
  }
}

async function boundedResponseText(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) throw toolError('tool_output_too_large', 'network response too large');
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function networkContains(allowed, requested) {
  return allowed.protocol === requested.protocol
    && allowed.host === requested.host
    && Number(allowed.port) === Number(requested.port)
    && allowed.locality === requested.locality
    && allowed.consequence === requested.consequence
    && requested.methods.every((method) => allowed.methods.includes(method));
}

class SecretReferenceBroker {
  constructor({ operation, resolver, signal, isActive }) {
    this.operation = operation;
    this.resolver = resolver;
    this.signal = signal;
    this.isActive = isActive;
    this.resolvedValues = [];
  }
  #checkActive() {
    if (this.signal?.aborted || this.isActive?.() === false) throw toolError('tool_cancelled', 'tool invocation cancelled');
  }
  async resolveMany(references) {
    this.#checkActive();
    if (!this.resolver?.resolve) throw toolError('tool_secret_denied', 'secret resolver unavailable');
    if (!Array.isArray(references) || references.some((ref) => !this.operation.secretReferences.includes(ref))) throw toolError('tool_secret_denied', 'secret reference denied');
    const values = [];
    for (const reference of references) {
      const value = await this.resolver.resolve(reference);
      if (typeof value !== 'string') throw toolError('tool_secret_denied', 'secret reference unavailable');
      values.push(value);
      this.resolvedValues.push(value);
    }
    return values;
  }
  clear() {
    this.resolvedValues.fill('');
  }
}

function builtinManifest({ id, name, handlerBindingId, operations }) {
  return validateReviewedToolManifest({
    schemaVersion: '1.1.0',
    contractVersion: '1.0.0',
    id,
    name,
    version: '1.0.0',
    handlerBindingId,
    operations
  });
}

function schema(properties, required = Object.keys(properties)) {
  return { type: 'object', additionalProperties: false, required, properties };
}

function outputSchema(properties, required = Object.keys(properties)) {
  return { type: 'object', additionalProperties: false, required, properties };
}

const baseOutputFields = {
  path: { type: 'string', minLength: 1, maxLength: 240 },
  sha256: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
  byteSize: { type: 'integer', minimum: 0 },
  idempotent: { type: 'boolean' }
};

function builtinTools({ loopbackPort = 4310 } = {}) {
  const pure = builtinManifest({
    id: 'tool:fixture-pure',
    name: 'Pure deterministic fixture',
    handlerBindingId: 'handler:pure:echo@1.0.0',
    operations: {
      echo: {
        sideEffectClass: 'read-only',
        inputSchema: schema({ value: { type: 'string', minLength: 1, maxLength: 120 } }),
        outputSchema: outputSchema({ echoed: { type: 'string', minLength: 1, maxLength: 120 }, grantId: { type: 'string', minLength: 1, maxLength: 128 } }, ['echoed']),
        filesystem: { read: [], write: [] },
        network: [],
        secretReferences: [],
        dataClasses: ['workspace-private'],
        sandbox: 'pure-local',
        limits: { runtimeMs: 1000, inputBytes: 1024, outputBytes: 2048, costUnits: 0 },
        approval: { required: false },
        idempotency: { required: false }
      }
    }
  });
  const read = builtinManifest({
    id: 'tool:filesystem-read',
    name: 'Read bounded workspace files',
    handlerBindingId: 'handler:brokered:workspace-file-read@1.0.0',
    operations: {
      readFile: {
        sideEffectClass: 'read-only',
        inputSchema: schema({ path: { type: 'string', minLength: 1, maxLength: 240 } }),
        outputSchema: outputSchema({ path: baseOutputFields.path, sha256: baseOutputFields.sha256, byteSize: baseOutputFields.byteSize }),
        filesystem: { read: ['workspace:root'], write: [] },
        network: [],
        secretReferences: [],
        dataClasses: ['workspace-private'],
        sandbox: 'brokered-filesystem-read',
        limits: { runtimeMs: 1000, inputBytes: 1024, outputBytes: 4096, costUnits: 0 },
        approval: { required: false },
        idempotency: { required: false }
      }
    }
  });
  const write = builtinManifest({
    id: 'tool:workspace-write',
    name: 'Write bounded workspace files',
    handlerBindingId: 'handler:brokered:workspace-file-write@1.0.0',
    operations: {
      writeFile: {
        sideEffectClass: 'reversible-write',
        inputSchema: schema({ path: { type: 'string', minLength: 1, maxLength: 240 }, content: { type: 'string', maxLength: 4096 } }),
        outputSchema: outputSchema(baseOutputFields, ['path', 'sha256', 'byteSize']),
        filesystem: { read: [], write: ['workspace:root'] },
        network: [],
        secretReferences: [],
        dataClasses: ['workspace-private'],
        sandbox: 'brokered-filesystem-write',
        limits: { runtimeMs: 1000, inputBytes: 8192, outputBytes: 4096, costUnits: 0 },
        approval: { required: false },
        idempotency: { required: true }
      }
    }
  });
  const loopback = builtinManifest({
    id: 'tool:loopback-read',
    name: 'Read exact loopback URL',
    handlerBindingId: 'handler:brokered:loopback-http-read@1.0.0',
    operations: {
      fetchText: {
        sideEffectClass: 'read-only',
        inputSchema: schema({ url: { type: 'string', minLength: 1, maxLength: 300 }, method: { enum: ['GET', 'HEAD', 'POST'] } }),
        outputSchema: outputSchema({ status: { type: 'integer', minimum: 100, maximum: 599 }, bodySha256: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, byteSize: { type: 'integer', minimum: 0 }, headers: { type: 'object', additionalProperties: { type: 'string', maxLength: 256 } } }),
        filesystem: { read: [], write: [] },
        network: [{ protocol: 'http', host: '127.0.0.1', port: loopbackPort, methods: ['GET', 'HEAD'], consequence: 'read', locality: 'loopback' }],
        secretReferences: [],
        dataClasses: ['workspace-private'],
        sandbox: 'brokered-loopback-http',
        limits: { runtimeMs: 1000, inputBytes: 1024, outputBytes: 4096, costUnits: 0 },
        approval: { required: false },
        idempotency: { required: false }
      }
    }
  });
  const secret = builtinManifest({
    id: 'tool:secret-fixture',
    name: 'Hash declared secret references',
    handlerBindingId: 'handler:brokered:secret-hash@1.0.0',
    operations: {
      hashSecret: {
        sideEffectClass: 'read-only',
        inputSchema: schema({ secretReferences: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string', pattern: '^secret:[A-Za-z0-9_.:-]{1,120}$' } } }),
        outputSchema: outputSchema({ secretCount: { type: 'integer', minimum: 0 }, combinedSha256: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' } }),
        filesystem: { read: [], write: [] },
        network: [],
        secretReferences: ['secret:fixture.read'],
        dataClasses: ['workspace-private'],
        sandbox: 'brokered-secret-reference',
        limits: { runtimeMs: 1000, inputBytes: 1024, outputBytes: 2048, costUnits: 0 },
        approval: { required: false },
        idempotency: { required: false }
      }
    }
  });
  return new Map([pure, read, write, loopback, secret].map((manifest) => [manifest.id, {
    entry: { toolId: manifest.id, enabled: true, handlerBindingId: manifest.handlerBindingId, reviewStatus: 'reviewed', reviewVersion: 'OAF-015' },
    manifest,
    enabled: true,
    manifestFingerprint: stableToolFingerprint(manifest)
  }]));
}

function defaultHandlers() {
  return new Map([
    ['handler:pure:echo@1.0.0', async ({ input, grant }) => ({ echoed: input.value, grantId: grant.grantId })],
    ['handler:brokered:workspace-file-read@1.0.0', async ({ input, brokers }) => {
      const read = await brokers.filesystem.readText(input.path);
      return { path: read.path, sha256: read.sha256, byteSize: read.byteSize };
    }],
    ['handler:brokered:workspace-file-write@1.0.0', async ({ input, brokers, effectBoundary, operationFingerprint, idempotencyKey }) => effectBoundary.effect({
      idempotencyKey,
      operationFingerprint,
      execute: async () => brokers.filesystem.writeText(input.path, input.content)
    })],
    ['handler:brokered:loopback-http-read@1.0.0', async ({ input, brokers }) => brokers.egress.fetchText(input)],
    ['handler:brokered:secret-hash@1.0.0', async ({ input, brokers }) => {
      const values = await brokers.secrets.resolveMany(input.secretReferences);
      return { secretCount: values.length, combinedSha256: `sha256:${sha256(values.join('|'))}` };
    }]
  ]);
}

export class ToolRegistry {
  #tools = new Map();
  #handlers = new Map();
  #policy;
  #grants;
  #eventSink;
  #workspaceRoot;
  #clock;
  #secretResolver;
  #telemetry;

  constructor({ policy = {}, catalog = null, handlers = new Map(), grantService = null, eventSink = null, workspaceRoot = process.cwd(), clock = () => new Date().toISOString(), secretResolver = null, telemetry = createTelemetry() } = {}) {
    this.#policy = createPolicyService(policy);
    this.#grants = grantService ?? new ToolGrantService({ clock });
    this.#eventSink = eventSink;
    this.#workspaceRoot = path.resolve(workspaceRoot);
    this.#clock = clock;
    this.#secretResolver = secretResolver;
    this.#telemetry = telemetry ?? createTelemetry();
    for (const [id, handler] of defaultHandlers()) this.#handlers.set(id, handler);
    for (const [id, handler] of handlers instanceof Map ? handlers : Object.entries(handlers)) this.#handlers.set(id, handler);
    if (catalog) {
      for (const tool of catalog.tools) this.#tools.set(tool.manifest.id, tool);
    }
  }

  static createForTests({ tools = [], handlers = {}, eventSink = null, workspaceRoot = process.cwd(), loopbackPort = 4310, clock = () => new Date().toISOString(), secretResolver = null } = {}) {
    const builtins = builtinTools({ loopbackPort });
    const selected = { tools: tools.map((id) => builtins.get(id)).filter(Boolean) };
    const registry = new ToolRegistry({
      catalog: selected,
      handlers: defaultHandlers(),
      eventSink,
      workspaceRoot,
      clock,
      secretResolver
    });
    for (const [id, handler] of Object.entries(handlers)) registry.#handlers.set(id, handler);
    return registry;
  }

  register(manifest, handler) {
    const reviewed = manifest.schemaVersion === '1.1.0' ? validateReviewedToolManifest(manifest) : legacyManifestToReviewed(manifest);
    if (typeof handler !== 'function') throw new TypeError('tool handler is required');
    if (this.#tools.has(reviewed.id)) throw new Error(`tool already registered: ${reviewed.id}`);
    this.#handlers.set(reviewed.handlerBindingId, async ({ input }) => handler(input));
    this.#tools.set(reviewed.id, {
      entry: { toolId: reviewed.id, enabled: true, handlerBindingId: reviewed.handlerBindingId, reviewStatus: 'reviewed', reviewVersion: 'compat' },
      manifest: reviewed,
      enabled: true,
      manifestFingerprint: stableToolFingerprint(reviewed)
    });
  }

  bindHandlerForTests(toolId, operation, handlerBindingId) {
    const tool = this.#tools.get(toolId);
    if (!tool) throw toolError('tool_not_registered');
    tool.manifest.operations[operation].handlerBindingId = handlerBindingId;
  }

  list() {
    return [...this.#tools.values()].map((tool) => ({
      id: tool.manifest.id,
      name: tool.manifest.name,
      version: tool.manifest.version,
      enabled: tool.enabled,
      manifestFingerprint: tool.manifestFingerprint,
      operations: Object.keys(tool.manifest.operations)
    }));
  }

  async invoke({ trustedContext = null, ...request } = {}) {
    return this.execute({
      schemaVersion: '1.0.0',
      requestId: request.requestId ?? 'toolreq_compat',
      correlationId: request.correlationId ?? 'req_tool-registry-compat',
      workspaceId: request.workspaceId ?? trustedContext?.membership?.workspaceId ?? 'ws_local',
      runId: request.runId ?? 'run_tool_registry_compat',
      stepId: request.stepId ?? 'step_tool_registry_compat',
      actorId: request.actorId,
      trustedContext,
      toolId: request.toolId,
      toolVersion: request.toolVersion ?? '0.1.0',
      operation: request.operation ?? 'invoke',
      input: request.input ?? {},
      requestedCapability: request.capabilityRequest ?? null,
      dataClass: request.dataClass ?? 'workspace-private',
      approvalContext: request.approvalContext ?? null,
      idempotencyKey: request.idempotencyKey ?? null,
      trustedTimestamp: request.trustedTimestamp ?? this.#clock(),
      signal: request.signal ?? null
    });
  }

  async execute(request) {
    const startedAt = this.#clock();
    let tool = null;
    let operationName = null;
    let operation = null;
    let grantId = null;
    let active = true;
    let span = null;
    try {
      assertNoForgedAuthority(request);
      validateInvocation(request);
      const trusted = assertTrustedContext(request);
      tool = this.#tools.get(request.toolId);
      if (!tool) throw toolError('tool_not_registered', 'tool is not registered');
      if (!tool.enabled) throw toolError('tool_disabled', 'tool is disabled');
      if (request.toolVersion !== tool.manifest.version) throw toolError('tool_request_invalid', 'tool version mismatch');
      if (request.manifestFingerprint && request.manifestFingerprint !== tool.manifestFingerprint) throw toolError('tool_manifest_invalid', 'manifest fingerprint mismatch');
      operationName = request.operation;
      operation = tool.manifest.operations[operationName];
      if (!operation) throw toolError('tool_operation_not_declared', 'operation is not declared');
      span = this.#telemetry.startSpan('oaf.tool.invoke', toolSpanAttributes({ toolId: tool.manifest.id, toolVersion: tool.manifest.version, operation: operationName, sideEffectClass: operation.sideEffectClass, sandbox: operation.sandbox, correlationId: request.correlationId, workspaceId: request.workspaceId, runId: request.runId, stepId: request.stepId }), request.traceContext ?? { correlationId: request.correlationId, workspaceId: request.workspaceId, runId: request.runId });
      if (!SANDBOX_PROFILES.has(operation.sandbox)) throw toolError('tool_sandbox_unavailable', 'unsupported sandbox profile');
      assertNoCallerApprovalAuthority(request.approvalContext);
      boundedJsonBytes(request.input ?? {}, operation.limits.inputBytes ?? DEFAULT_LIMITS.inputBytes, 'tool_request_invalid');
      try { assertJsonSchema(operation.inputSchema, request.input ?? {}, 'tool input'); } catch { throw toolError('tool_input_schema_failed', 'input schema failed'); }
      await this.#emit('tool.requested', request, { toolId: tool.manifest.id, toolVersion: tool.manifest.version, manifestFingerprint: tool.manifestFingerprint, operation: operationName, inputFingerprint: inputFingerprint(request.input), sideEffectClass: operation.sideEffectClass, sandbox: operation.sandbox });
      const capability = operationCapability({ tool, operationName, requestedCapability: request.requestedCapability, timeoutMs: request.timeoutMs, outputLimitBytes: request.outputLimitBytes });
      const policyRequest = {
        schemaVersion: '1.0.0',
        requestId: `polreq_${request.requestId}`,
        correlationId: request.correlationId,
        operationId: `tool:${tool.manifest.id}:${operationName}`,
        principal: { ...trusted.principal, agentRole: trusted.principal.agentRole ?? request.trustedAgentRole },
        workspaceId: request.workspaceId,
        membership: trusted.membership,
        action: 'tool.invoke',
        resource: { type: 'tool', id: tool.manifest.id, workspaceId: request.workspaceId, dataClass: request.dataClass ?? 'workspace-private' },
        environment: trusted.environment,
        capabilityRequest: capability,
        trustedToolManifest: operationToPolicyManifest(tool, operationName),
        approvalContext: request.approvalContext ?? null,
        idempotencyKey: request.idempotencyKey ?? null,
        trustedTimestamp: request.trustedTimestamp,
        payloadFingerprint: inputFingerprint(request.input)
      };
      const policy = await this.#policy.evaluate(policyRequest);
      if (policy.outcome !== 'allow') {
        await this.#emit('tool.denied', request, { toolId: tool.manifest.id, toolVersion: tool.manifest.version, manifestFingerprint: tool.manifestFingerprint, operation: operationName, inputFingerprint: inputFingerprint(request.input), policyDecisionId: policy.decisionId, policyVersion: policy.policyVersion, policyFingerprint: policy.policyFingerprint, reasonCodes: policy.reasonCodes });
        span.end('ok', toolSpanAttributes({ toolId: tool.manifest.id, toolVersion: tool.manifest.version, operation: operationName, sideEffectClass: operation.sideEffectClass, sandbox: operation.sandbox, policyDecisionId: policy.decisionId, policyVersion: policy.policyVersion, status: 'denied', correlationId: request.correlationId, workspaceId: request.workspaceId, runId: request.runId, stepId: request.stepId }));
        return this.#safeDenied(request, 'tool_policy_denied', policy);
      }
      if (operation.approval.required && !request.approvalContext) throw toolError('tool_approval_required', 'approval required');
      if (operation.idempotency.required && !request.idempotencyKey) throw toolError('tool_idempotency_required', 'idempotency key required');
      if (operation.sideEffectClass !== 'read-only' && !request.effectBoundary?.effect) throw toolError('tool_effect_boundary_required', 'write operation requires effect boundary');
      const operationFingerprint = canonicalOperationFingerprint(policyRequest);
      const binding = exactBinding({ request, tool, operationName, capability, policy, operationFingerprint });
      const grant = this.#grants.issue({ binding, ttlMs: Math.min(DEFAULT_LIMITS.grantTtlMs, capability.limits.runtimeMs ?? DEFAULT_LIMITS.runtimeMs) });
      grantId = grant.record.grantId;
      await this.#emit('tool.authorized', request, { toolId: tool.manifest.id, toolVersion: tool.manifest.version, manifestFingerprint: tool.manifestFingerprint, operation: operationName, grantId, policyDecisionId: policy.decisionId, policyVersion: policy.policyVersion, policyFingerprint: policy.policyFingerprint, inputFingerprint: binding.inputFingerprint, operationFingerprint, sideEffectClass: operation.sideEffectClass, sandbox: operation.sandbox, timeoutMs: capability.limits.runtimeMs, outputBytes: capability.limits.outputBytes, idempotencyKeyFingerprint: binding.idempotencyFingerprint });
      const consumed = this.#grants.consume(grant.token, binding);
      if (consumed.status !== 'consumed') throw toolError(consumed.code, consumed.code);
      const handlerBindingId = operation.handlerBindingId ?? tool.manifest.handlerBindingId;
      const handler = this.#handlers.get(handlerBindingId);
      if (!handler) throw toolError('tool_sandbox_unavailable', 'handler binding unavailable');
      const timeoutMs = Math.max(1, Math.min(operation.limits.runtimeMs ?? DEFAULT_LIMITS.runtimeMs, request.timeoutMs ?? operation.limits.runtimeMs ?? DEFAULT_LIMITS.runtimeMs));
      const outputLimit = Math.max(1, Math.min(operation.limits.outputBytes ?? DEFAULT_LIMITS.outputBytes, request.outputLimitBytes ?? operation.limits.outputBytes ?? DEFAULT_LIMITS.outputBytes));
      const run = async (signal) => {
        const brokers = {
          filesystem: new WorkspaceFilesystemBroker({ root: this.#workspaceRoot, signal, isActive: () => active }),
          egress: new LoopbackEgressBroker({ operation, signal, isActive: () => active }),
          secrets: new SecretReferenceBroker({ operation, resolver: request.secretResolver ?? this.#secretResolver, signal, isActive: () => active })
        };
        try {
          const output = await handler({
            input: safeClone(request.input ?? {}),
            grant: consumed.record,
            brokers,
            signal,
            effectBoundary: request.effectBoundary,
            operationFingerprint,
            idempotencyKey: request.idempotencyKey ?? null
          });
          noSecretLeak(output, brokers.secrets.resolvedValues);
          brokers.secrets.clear();
          return output;
        } catch (error) {
          brokers.secrets.clear();
          throw error;
        }
      };
      const output = await withDeadline({ run, timeoutMs, signal: request.signal, onAbort: () => { active = false; } });
      active = false;
      boundedJsonBytes(output, outputLimit, 'tool_output_too_large');
      try { assertJsonSchema(operation.outputSchema, output, 'tool output'); } catch { throw toolError('tool_output_schema_failed', 'output schema failed'); }
      const completedAt = this.#clock();
      const result = {
        schemaVersion: '1.0.0',
        invocationId: `toolinv_${sha256(`${request.requestId}:${grantId}`).slice(0, 16)}`,
        requestId: request.requestId,
        correlationId: request.correlationId,
        workspaceId: request.workspaceId,
        runId: request.runId,
        stepId: request.stepId,
        toolId: tool.manifest.id,
        toolVersion: tool.manifest.version,
        manifestFingerprint: tool.manifestFingerprint,
        operation: operationName,
        grantId,
        policyDecisionId: policy.decisionId,
        policyVersion: policy.policyVersion,
        policyFingerprint: policy.policyFingerprint,
        inputFingerprint: binding.inputFingerprint,
        outputFingerprint: stableToolFingerprint(output),
        status: 'completed',
        startedAt,
        completedAt,
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
        reconciliation: operation.idempotency.required ? 'effect-boundary' : 'not-required',
        output
      };
      await this.#emit('tool.completed', request, { toolId: tool.manifest.id, toolVersion: tool.manifest.version, manifestFingerprint: tool.manifestFingerprint, operation: operationName, grantId, policyDecisionId: policy.decisionId, policyVersion: policy.policyVersion, policyFingerprint: policy.policyFingerprint, inputFingerprint: result.inputFingerprint, outputFingerprint: result.outputFingerprint, sideEffectClass: operation.sideEffectClass, sandbox: operation.sandbox, reconciliation: result.reconciliation, durationMs: result.durationMs });
      span.end('ok', toolSpanAttributes({ toolId: tool.manifest.id, toolVersion: tool.manifest.version, operation: operationName, sideEffectClass: operation.sideEffectClass, sandbox: operation.sandbox, policyDecisionId: policy.decisionId, policyVersion: policy.policyVersion, status: 'completed', correlationId: request.correlationId, workspaceId: request.workspaceId, runId: request.runId, stepId: request.stepId }));
      return result;
    } catch (error) {
      active = false;
      const safe = sanitizeError(error);
      const status = safe.code === 'tool_policy_denied' || safe.code === 'tool_trusted_context_required' || safe.code === 'tool_request_invalid' ? 'denied' : 'failed';
      if (request?.workspaceId && request?.runId && tool && operationName) {
        await this.#emit(status === 'denied' ? 'tool.denied' : 'tool.failed', request, { toolId: tool.manifest.id, toolVersion: tool.manifest.version, manifestFingerprint: tool.manifestFingerprint, operation: operationName, grantId, errorCode: safe.code, inputFingerprint: inputFingerprint(request.input ?? {}) }).catch(() => {});
      }
      span?.end(status === 'denied' ? 'ok' : 'error', toolSpanAttributes({ toolId: tool?.manifest.id ?? request?.toolId, toolVersion: tool?.manifest.version ?? request?.toolVersion, operation: operationName ?? request?.operation, sideEffectClass: operation?.sideEffectClass, sandbox: operation?.sandbox, status, correlationId: request?.correlationId, workspaceId: request?.workspaceId, runId: request?.runId, stepId: request?.stepId }));
      return {
        schemaVersion: '1.0.0',
        requestId: request?.requestId ?? null,
        correlationId: request?.correlationId ?? null,
        workspaceId: request?.workspaceId ?? null,
        runId: request?.runId ?? null,
        stepId: request?.stepId ?? null,
        toolId: request?.toolId ?? null,
        operation: request?.operation ?? null,
        grantId,
        status,
        error: safe,
        output: null
      };
    }
  }

  #safeDenied(request, code, policy = null) {
    return {
      schemaVersion: '1.0.0',
      requestId: request.requestId,
      correlationId: request.correlationId,
      workspaceId: request.workspaceId,
      runId: request.runId,
      stepId: request.stepId,
      toolId: request.toolId,
      operation: request.operation,
      grantId: null,
      policy,
      status: 'denied',
      error: { code, message: code },
      output: null
    };
  }

  async #emit(type, request, payload) {
    if (!this.#eventSink) return null;
    const event = createEvent({
      type,
      workspaceId: request.workspaceId,
      runId: request.runId,
      actorId: request.actorId,
      correlationId: request.correlationId,
      payload: safeEventPayload(payload),
      sequence: 0
    });
    await this.#eventSink(event);
    return event;
  }
}

function legacyManifestToReviewed(manifest) {
  if (!manifest?.id) throw new TypeError('tool manifest and handler are required');
  return validateReviewedToolManifest({
    schemaVersion: '1.1.0',
    contractVersion: '1.0.0',
    id: manifest.id,
    name: manifest.name ?? manifest.id,
    version: manifest.version ?? '0.1.0',
    handlerBindingId: `handler:compat:${manifest.id}@${manifest.version ?? '0.1.0'}`,
    operations: {
      invoke: {
        sideEffectClass: manifest.riskClass ?? 'read-only',
        inputSchema: manifest.inputSchema ?? { type: 'object', additionalProperties: true },
        outputSchema: manifest.outputSchema ?? { type: 'object', additionalProperties: true },
        filesystem: manifest.permissions?.filesystem ?? { read: [], write: [] },
        network: [],
        secretReferences: manifest.permissions?.secrets ?? [],
        dataClasses: ['workspace-private'],
        sandbox: manifest.riskClass === 'read-only' ? 'pure-local' : 'brokered-filesystem-write',
        limits: { runtimeMs: manifest.timeoutMs ?? DEFAULT_LIMITS.runtimeMs, inputBytes: DEFAULT_LIMITS.inputBytes, outputBytes: manifest.outputLimitBytes ?? DEFAULT_LIMITS.outputBytes, costUnits: 0 },
        approval: { required: manifest.approval?.required === true },
        idempotency: { required: manifest.riskClass !== 'read-only' }
      }
    }
  });
}
