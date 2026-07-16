import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { assertJsonSchema } from '../../../../packages/protocol/src/schema-validator.mjs';
import requestSchema from '../../../../packages/protocol/schemas/code-intelligence-engine-request.schema.json' with { type: 'json' };
import responseSchema from '../../../../packages/protocol/schemas/code-intelligence-engine-response.schema.json' with { type: 'json' };
import graphSchema from '../../../../packages/protocol/schemas/code-intelligence-graph.schema.json' with { type: 'json' };

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const DEFAULT_BINARY = path.join(PACKAGE_ROOT, 'rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf');
const CAPABILITIES = Object.freeze([
  'code-intelligence.graph.build',
  'code-intelligence.local-read-only',
  'code-intelligence.native-preview'
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
    binaryPath = process.env.MEMORY_RECALL_NATIVE_BINARY ?? DEFAULT_BINARY,
    timeoutMs = 30_000,
    maxStdoutBytes = 2_000_000,
    maxStderrBytes = 64 * 1024
  } = {}) {
    this.binaryPath = path.resolve(binaryPath);
    this.timeoutMs = boundedInteger(timeoutMs, 1, 120_000, 'native_engine_timeout_invalid');
    this.maxStdoutBytes = boundedInteger(maxStdoutBytes, 1, 10_000_000, 'native_engine_stdout_limit_invalid');
    this.maxStderrBytes = boundedInteger(maxStderrBytes, 1, 1_000_000, 'native_engine_stderr_limit_invalid');
  }

  async health() {
    try {
      await this.#resolveBinary();
      return Object.freeze({ status: 'healthy', details: Object.freeze({ binary: 'available', previewOnly: true }) });
    } catch {
      return Object.freeze({ status: 'unavailable', details: Object.freeze({ binary: 'unavailable', previewOnly: true }) });
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
    const binary = await this.#resolveBinary();
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

  async #resolveBinary() {
    try {
      const resolved = await realpath(this.binaryPath);
      const metadata = await stat(resolved);
      if (!metadata.isFile()) throw new Error('not a file');
      return resolved;
    } catch {
      throw new NativeCodeIntelligenceError('native_engine_unavailable');
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

function runNativeProcess({ binary, workspace, request, timeoutMs, maxStdoutBytes, maxStderrBytes, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const child = spawn(binary, ['code-intelligence', 'serve', '--stdio'], {
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
