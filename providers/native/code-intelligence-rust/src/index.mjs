import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { assertJsonSchema } from '../../../../packages/protocol/src/schema-validator.mjs';
import { resolveNativeBinary } from './binary-resolver.mjs';
import requestSchema from '../../../../packages/protocol/schemas/code-intelligence-engine-request.schema.json' with { type: 'json' };
import responseSchema from '../../../../packages/protocol/schemas/code-intelligence-engine-response.schema.json' with { type: 'json' };
import graphSchema from '../../../../packages/protocol/schemas/code-intelligence-graph.schema.json' with { type: 'json' };
import indexRequestSchema from '../../../../packages/protocol/schemas/code-intelligence-index-request.schema.json' with { type: 'json' };
import indexResponseSchema from '../../../../packages/protocol/schemas/code-intelligence-index-response.schema.json' with { type: 'json' };
import repositoryRequestSchema from '../../../../packages/protocol/schemas/code-intelligence-repository-request.schema.json' with { type: 'json' };
import repositoryResponseSchema from '../../../../packages/protocol/schemas/code-intelligence-repository-response.schema.json' with { type: 'json' };

const CAPABILITIES = Object.freeze([
  'code-intelligence.graph.build',
  'code-intelligence.index.build',
  'code-intelligence.index.refresh',
  'code-intelligence.index.repair',
  'code-intelligence.index.status',
  'code-intelligence.index.doctor',
  'code-intelligence.index.query',
  'code-intelligence.repository.register',
  'code-intelligence.repository.list',
  'code-intelligence.repository.search',
  'code-intelligence.repository.go.resolve',
  'code-intelligence.repository.go.trace',
  'code-intelligence.repository.go.impact',
  'code-intelligence.local-read-only',
  'code-intelligence.native'
]);
const PRIVATE_PATH = /(?:^|[\s"'(])(?:\/Users\/|\/home\/[A-Za-z0-9._-]+\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\)/u;

export class NativeCodeIntelligenceError extends Error {
  constructor(code, { retryable = false, details = [] } = {}) {
    super(`Native code intelligence failed: ${code}`);
    this.name = 'NativeCodeIntelligenceError';
    this.code = code;
    this.retryable = retryable;
    this.details = Object.freeze([...details]);
  }
}

export class RustCodeIntelligenceProvider {
  constructor({
    binaryPath = process.env.MEMORY_RECALL_NATIVE_BINARY,
    binarySha256 = process.env.MEMORY_RECALL_NATIVE_SHA256,
    timeoutMs = 30_000,
    maxStdoutBytes = 8_000_000,
    maxStderrBytes = 64 * 1024
  } = {}) {
    this.binaryPath = binaryPath === undefined ? undefined : path.resolve(binaryPath);
    this.binarySha256 = binarySha256;
    this.binaryResolution = null;
    this.timeoutMs = boundedInteger(timeoutMs, 1, 120_000, 'native_engine_timeout_invalid');
    this.maxStdoutBytes = boundedInteger(maxStdoutBytes, 1, 10_000_000, 'native_engine_stdout_limit_invalid');
    this.maxStderrBytes = boundedInteger(maxStderrBytes, 1, 1_000_000, 'native_engine_stderr_limit_invalid');
  }

  async health() {
    try {
      const selected = await this.#resolveBinary();
      return Object.freeze({
        status: 'healthy',
        details: Object.freeze({
          binary: 'available',
          source: selected.source,
          target: selected.target,
          verified: selected.verified,
          productionDefault: true
        })
      });
    } catch (error) {
      return Object.freeze({
        status: 'unavailable',
        details: Object.freeze({ binary: 'unavailable', reason: error?.code ?? 'native_engine_unavailable', productionDefault: true })
      });
    }
  }

  async capabilities() {
    return CAPABILITIES;
  }

  async buildGraph({
    root,
    workspaceId = 'ws_local',
    maxFiles = 1000,
    maxFileBytes = 512 * 1024,
    maxNodes = 5000,
    maxEdges = 10000,
    languages,
    signal
  } = {}) {
    const workspace = await resolveWorkspace(root);
    const { path: binary } = await this.#resolveBinary();
    const requestId = `cireq_${randomBytes(16).toString('hex')}`;
    const request = {
      protocolVersion: '1.0.0',
      requestId,
      workspaceId,
      operation: 'graph.build',
      root: '.',
      deadlineMs: this.timeoutMs,
      cancellationToken: `cancel_${randomBytes(16).toString('hex')}`,
      responseSchemaVersion: '1.0.0',
      arguments: {
        maxFiles,
        maxFileBytes,
        maxNodes,
        maxEdges,
        ...(languages === undefined ? {} : { languages })
      }
    };
    try {
      assertJsonSchema(requestSchema, request, 'native code intelligence request');
    } catch {
      throw new NativeCodeIntelligenceError('native_engine_request_invalid');
    }
    if (signal?.aborted) throw new NativeCodeIntelligenceError('native_engine_cancelled');
    const stdout = await runNativeProcess({
      binary,
      workspace,
      request,
      commandArgs: ['code-intelligence', 'serve', '--stdio'],
      timeoutMs: this.timeoutMs,
      maxStdoutBytes: this.maxStdoutBytes,
      maxStderrBytes: this.maxStderrBytes,
      signal
    });
    const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
    if (lines.length !== 1) throw new NativeCodeIntelligenceError('native_engine_response_invalid');
    let frame;
    try {
      frame = JSON.parse(lines[0]);
      assertJsonSchema(responseSchema, frame, 'native code intelligence response');
    } catch {
      throw new NativeCodeIntelligenceError('native_engine_response_invalid');
    }
    if (frame.requestId !== requestId) throw new NativeCodeIntelligenceError('native_engine_response_mismatch');
    if (!frame.ok) {
      throw new NativeCodeIntelligenceError(frame.error.code, {
        retryable: frame.error.retryable,
        details: frame.error.details
      });
    }
    try {
      assertJsonSchema(graphSchema, frame.result.graph, 'native code intelligence graph');
    } catch {
      throw new NativeCodeIntelligenceError('native_engine_graph_invalid');
    }
    const serialized = JSON.stringify(frame.result.graph);
    if (serialized.includes(workspace) || PRIVATE_PATH.test(serialized)) {
      throw new NativeCodeIntelligenceError('native_engine_graph_unsafe');
    }
    return deepFreeze(frame.result.graph);
  }

  async buildIndex(options = {}) {
    return this.#indexOperation('index.build', options, writerArguments(options));
  }

  async refreshIndex(options = {}) {
    return this.#indexOperation('index.refresh', options, writerArguments(options));
  }

  async repairIndex(options = {}) {
    const confirmRepairPlan = options.confirmRepairPlan;
    return this.#indexOperation('index.repair', options, {
      ...writerArguments(options),
      confirmRepairPlan
    });
  }

  async indexStatus(options = {}) {
    return this.#indexOperation('index.status', options, {});
  }

  async doctorIndex(options = {}) {
    return this.#indexOperation('index.doctor', options, {});
  }

  async queryIndex(options = {}) {
    const { kind, query, locator, direction, depth, edgeKinds, limit = 25, cursor } = options;
    return this.#indexOperation('index.query', options, {
      kind,
      limit,
      ...(query === undefined ? {} : { query }),
      ...(locator === undefined ? {} : { locator }),
      ...(direction === undefined ? {} : { direction }),
      ...(depth === undefined ? {} : { depth }),
      ...(edgeKinds === undefined ? {} : { edgeKinds }),
      ...(cursor === undefined ? {} : { cursor })
    });
  }

  async registerRepository({ root, workspaceId = 'ws_local', displayName, rootLocator, signal } = {}) {
    return this.#repositoryOperation('repository.register', { root, workspaceId, signal }, {
      write: true,
      displayName,
      rootLocator
    });
  }

  async listRepositories({ root, workspaceId = 'ws_local', limit = 64, signal } = {}) {
    return this.#repositoryOperation('repository.list', { root, workspaceId, signal }, { limit });
  }

  async searchRepositories({
    root,
    workspaceId = 'ws_local',
    query,
    repositoryIds,
    perRepositoryLimit = 25,
    limit = 50,
    signal
  } = {}) {
    return this.#repositoryOperation('repository.search', { root, workspaceId, signal }, {
      query,
      repositoryIds,
      perRepositoryLimit,
      limit
    });
  }

  async resolveGoRepositories(options = {}) {
    return this.#repositoryOperation(
      'repository.go.resolve',
      options,
      goRepositoryArguments(options)
    );
  }

  async traceGoRepositories({ limit = 25, ...options } = {}) {
    return this.#repositoryOperation(
      'repository.go.trace',
      options,
      goRepositoryArguments(options, limit)
    );
  }

  async impactGoRepositories({ limit = 25, ...options } = {}) {
    return this.#repositoryOperation(
      'repository.go.impact',
      options,
      goRepositoryArguments(options, limit)
    );
  }

  async #indexOperation(operation, options, argumentsValue) {
    const workspace = await resolveWorkspace(options.root);
    const { path: binary } = await this.#resolveBinary();
    const requestId = `ciidxreq_${randomBytes(16).toString('hex')}`;
    const request = {
      protocolVersion: '1.0.0',
      requestId,
      workspaceId: options.workspaceId ?? 'ws_local',
      operation,
      root: '.',
      indexLocator: 'workspace://.local/source-index/index.v1.sqlite',
      deadlineMs: this.timeoutMs,
      cancellationToken: `cancel_${randomBytes(16).toString('hex')}`,
      responseSchemaVersion: '1.0.0',
      arguments: argumentsValue
    };
    try {
      assertJsonSchema(indexRequestSchema, request, 'native source index request');
    } catch {
      throw new NativeCodeIntelligenceError('native_index_request_invalid');
    }
    if (options.signal?.aborted) throw new NativeCodeIntelligenceError('native_engine_cancelled');
    const stdout = await runNativeProcess({
      binary,
      workspace,
      request,
      commandArgs: ['code-intelligence', 'index', '--stdio'],
      timeoutMs: this.timeoutMs,
      maxStdoutBytes: this.maxStdoutBytes,
      maxStderrBytes: this.maxStderrBytes,
      signal: options.signal
    });
    const frame = parseFrame(stdout, indexResponseSchema, requestId, 'native_index_response_invalid');
    if (!frame.ok) {
      throw new NativeCodeIntelligenceError(frame.error.code, {
        retryable: frame.error.retryable,
        details: frame.error.details
      });
    }
    const serialized = JSON.stringify(frame.result);
    if (serialized.includes(workspace) || PRIVATE_PATH.test(serialized)) {
      throw new NativeCodeIntelligenceError('native_index_response_unsafe');
    }
    return deepFreeze(frame.result);
  }

  async #repositoryOperation(operation, options, argumentsValue) {
    if (options.signal?.aborted) throw new NativeCodeIntelligenceError('native_engine_cancelled');
    const workspace = await resolveWorkspace(options.root);
    const { path: binary } = await this.#resolveBinary();
    const requestId = `cireporeq_${randomBytes(16).toString('hex')}`;
    const timeoutMs = operation === 'repository.search' || operation.startsWith('repository.go.')
      ? Math.min(this.timeoutMs, 2000)
      : this.timeoutMs;
    const request = {
      protocolVersion: '1.0.0',
      requestId,
      workspaceId: options.workspaceId ?? 'ws_local',
      operation,
      root: '.',
      registryLocator: 'workspace://.local/source-index/registry.v1.sqlite',
      deadlineMs: timeoutMs,
      responseSchemaVersion: '1.0.0',
      arguments: argumentsValue
    };
    try {
      assertJsonSchema(repositoryRequestSchema, request, 'native repository request');
    } catch {
      throw new NativeCodeIntelligenceError('native_repository_request_invalid');
    }
    const stdout = await runNativeProcess({
      binary,
      workspace,
      request,
      commandArgs: ['code-intelligence', 'repositories', '--stdio'],
      timeoutMs,
      maxStdoutBytes: this.maxStdoutBytes,
      maxStderrBytes: this.maxStderrBytes,
      signal: options.signal
    });
    const frame = parseFrame(stdout, repositoryResponseSchema, requestId, 'native_repository_response_invalid');
    if (!frame.ok) {
      throw new NativeCodeIntelligenceError(frame.error.code, {
        retryable: frame.error.retryable,
        details: frame.error.details
      });
    }
    const serialized = JSON.stringify(frame.result);
    if (serialized.includes(workspace) || PRIVATE_PATH.test(serialized)) {
      throw new NativeCodeIntelligenceError('native_repository_response_unsafe');
    }
    return deepFreeze(frame.result);
  }

  async #resolveBinary() {
    if (this.binaryResolution) return this.binaryResolution;
    try {
      this.binaryResolution = await resolveNativeBinary({
        binaryPath: this.binaryPath,
        expectedSha256: this.binarySha256
      });
      return this.binaryResolution;
    } catch (error) {
      throw new NativeCodeIntelligenceError(error?.code ?? 'native_engine_unavailable');
    }
  }
}

async function resolveWorkspace(root) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new NativeCodeIntelligenceError('native_engine_workspace_invalid');
  }
  try {
    const resolved = await realpath(path.resolve(root));
    const metadata = await stat(resolved);
    if (!metadata.isDirectory()) throw new Error('not a directory');
    return resolved;
  } catch {
    throw new NativeCodeIntelligenceError('native_engine_workspace_invalid');
  }
}

function goRepositoryArguments({
  repositoryIds,
  clientRepositoryId,
  serviceRepositoryId,
  clientEntryNativeId,
  serviceTargetNativeId
}, limit) {
  if (!Array.isArray(repositoryIds)
    || repositoryIds.length !== 2
    || repositoryIds[0] !== clientRepositoryId
    || repositoryIds[1] !== serviceRepositoryId
    || clientRepositoryId === serviceRepositoryId) {
    throw new NativeCodeIntelligenceError('native_repository_request_invalid');
  }
  return {
    repositoryIds,
    clientRepositoryId,
    serviceRepositoryId,
    clientEntryNativeId,
    serviceTargetNativeId,
    ...(limit === undefined ? {} : { limit })
  };
}

function runNativeProcess({ binary, workspace, request, commandArgs, timeoutMs, maxStdoutBytes, maxStderrBytes, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const child = spawn(binary, commandArgs, {
      cwd: workspace,
      env: Object.freeze({
        PATH: process.env.PATH ?? '',
        LANG: 'C',
        LC_ALL: 'C'
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true
    });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!child.killed) child.kill('SIGKILL');
      reject(error);
    };
    const onAbort = () => fail(new NativeCodeIntelligenceError('native_engine_cancelled'));
    const timer = setTimeout(
      () => fail(new NativeCodeIntelligenceError('native_engine_timeout', { retryable: true })),
      timeoutMs
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', () => fail(new NativeCodeIntelligenceError('native_engine_process_failed')));
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        fail(new NativeCodeIntelligenceError('native_engine_stdout_limit'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderrBytes) fail(new NativeCodeIntelligenceError('native_engine_stderr_limit'));
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code !== 0) {
        reject(new NativeCodeIntelligenceError('native_engine_process_failed'));
        return;
      }
      resolve(Buffer.concat(stdout, stdoutBytes).toString('utf8'));
    });
    child.stdin.once('error', () => fail(new NativeCodeIntelligenceError('native_engine_process_failed')));
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function writerArguments({
  maxFiles = 1000,
  maxFileBytes = 512 * 1024,
  maxNodes = 5000,
  maxEdges = 10000,
  languages
} = {}) {
  return {
    write: true,
    maxFiles,
    maxFileBytes,
    maxNodes,
    maxEdges,
    ...(languages === undefined ? {} : { languages })
  };
}

function parseFrame(stdout, schema, requestId, invalidCode) {
  const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) throw new NativeCodeIntelligenceError(invalidCode);
  let frame;
  try {
    frame = JSON.parse(lines[0]);
    assertJsonSchema(schema, frame, 'native process response');
  } catch {
    throw new NativeCodeIntelligenceError(invalidCode);
  }
  if (frame.requestId !== requestId) throw new NativeCodeIntelligenceError('native_engine_response_mismatch');
  return frame;
}

function boundedInteger(value, minimum, maximum, code) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new NativeCodeIntelligenceError(code);
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}
