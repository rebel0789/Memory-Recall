import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';
import requestSchema from '../packages/protocol/schemas/code-intelligence-engine-request.schema.json' with { type: 'json' };
import responseSchema from '../packages/protocol/schemas/code-intelligence-engine-response.schema.json' with { type: 'json' };
import graphSchema from '../packages/protocol/schemas/code-intelligence-graph.schema.json' with { type: 'json' };

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const BINARY = path.join(ROOT, 'rust', 'target', 'release', process.platform === 'win32' ? 'oaf.exe' : 'oaf');
const workspace = mkdtempSync(path.join(os.tmpdir(), 'memory-recall-native-protocol-'));

function request(overrides = {}) {
  return {
    protocolVersion: '1.0.0',
    requestId: 'cireq_0123456789abcdef0123456789abcdef',
    workspaceId: 'ws_local',
    operation: 'graph.build',
    root: '.',
    deadlineMs: 30000,
    cancellationToken: 'cancel_0123456789abcdef0123456789abcdef',
    responseSchemaVersion: '1.0.0',
    arguments: {
      maxFiles: 100,
      maxFileBytes: 524288,
      maxNodes: 500,
      maxEdges: 1000,
      languages: ['javascript', 'typescript']
    },
    ...overrides
  };
}

function run(lines) {
  return spawnSync(BINARY, ['code-intelligence', 'serve', '--stdio'], {
    cwd: workspace,
    encoding: 'utf8',
    input: `${lines.join('\n')}\n`,
    env: { PATH: process.env.PATH ?? '' },
    timeout: 30000,
    maxBuffer: 2_000_000
  });
}

function entries(root, prefix = '') {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? [relative, ...entries(path.join(root, entry.name), relative)] : [relative];
    })
    .sort();
}

try {
  mkdirSync(path.join(workspace, 'src'), { recursive: true });
  writeFileSync(path.join(workspace, 'src', 'helper.js'), 'export function helper(){ return 1; }\n');
  writeFileSync(path.join(workspace, 'src', 'index.ts'), [
    "import { helper } from './helper.js';",
    'export class Runner { run(){ return helper(); } }',
    'export function main(){ return new Runner().run(); }'
  ].join('\n'));
  const before = entries(workspace);
  const valid = request();
  assert.equal(validateJsonSchema(requestSchema, valid).valid, true);

  const result = run([JSON.stringify(valid), JSON.stringify({ ...valid, requestId: 'cireq_abcdef0123456789abcdef0123456789' })]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.includes(workspace), false);
  const frames = result.stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(frames.length, 2);
  for (const frame of frames) {
    assert.equal(validateJsonSchema(responseSchema, frame).valid, true);
    assert.equal(frame.ok, true);
    assert.equal(validateJsonSchema(graphSchema, frame.result.graph).valid, true);
    assert.equal(frame.result.safeguards.localFilesWritten, 0);
    assert.equal(frame.result.safeguards.networkCalls, 0);
    assert.equal(frame.result.safeguards.rawSourceBodiesIncluded, false);
    assert.equal(JSON.stringify(frame).includes(workspace), false);
    assert.equal(JSON.stringify(frame).includes('return new Runner'), false);
  }
  assert.equal(frames[0].result.graph.graphFingerprint, frames[1].result.graph.graphFingerprint);
  assert.equal(frames[0].result.graph.generation.id, frames[1].result.graph.generation.id);
  assert.deepEqual(entries(workspace), before);

  const bounded = run([JSON.stringify({
    ...valid,
    requestId: 'cireq_33333333333333333333333333333333',
    arguments: { ...valid.arguments, maxNodes: 1, maxEdges: 1 }
  })]);
  assert.equal(bounded.status, 0, bounded.stderr);
  const boundedFrame = JSON.parse(bounded.stdout);
  assert.equal(boundedFrame.result.graph.nodes.length, 1);
  assert(boundedFrame.result.graph.edges.length <= 1);
  assert(boundedFrame.result.measurements.omittedNodeCount > 0);
  assert.equal(validateJsonSchema(graphSchema, boundedFrame.result.graph).valid, true);

  const failures = run([
    '{invalid-json',
    JSON.stringify({ ...valid, requestId: 'cireq_11111111111111111111111111111111', protocolVersion: '2.0.0' }),
    JSON.stringify({ ...valid, requestId: 'cireq_22222222222222222222222222222222', root: '/private/tmp/repository' })
  ]);
  assert.equal(failures.status, 0, failures.stderr);
  const failureFrames = failures.stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(failureFrames.length, 3);
  assert.deepEqual(failureFrames.map((frame) => frame.error.code), [
    'engine_invalid_json',
    'engine_unsupported_version',
    'engine_invalid_request'
  ]);
  assert.equal(failureFrames.every((frame) => validateJsonSchema(responseSchema, frame).valid), true);
  assert.equal(JSON.stringify(failureFrames).includes('/private/tmp'), false);
  assert.deepEqual(entries(workspace), before);

  const oversized = run([`{"padding":"${'x'.repeat(70_000)}"}`]);
  assert.equal(oversized.status, 0, oversized.stderr);
  const oversizedFrame = JSON.parse(oversized.stdout);
  assert.equal(oversizedFrame.error.code, 'engine_input_too_large');
  assert.equal(validateJsonSchema(responseSchema, oversizedFrame).valid, true);

  console.log(JSON.stringify({
    command: 'rust code intelligence protocol quality',
    passed: true,
    frames: frames.length,
    failureFrames: failureFrames.length,
    nodeCount: frames[0].result.graph.nodes.length,
    edgeCount: frames[0].result.graph.edges.length,
    deterministicFingerprint: true,
    localFilesWritten: 0,
    networkCalls: 0
  }, null, 2));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
