import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MILLION_NODE_PLAN,
  createDenseFixturePlan,
  writeDenseFixture
} from '../scripts/code-intelligence-million-node-index.mjs';

test('million-node benchmark plan and dense fixture are exact, bounded, and deterministic', async () => {
  assert.deepEqual(MILLION_NODE_PLAN, {
    language: 'javascript',
    fileCount: 10,
    methodsPerFile: 99_997,
    expectedNodeCount: 1_000_000,
    expectedEdgeCount: 999_990,
    maxFileBytes: 1_048_576,
    maxNodes: 1_000_000,
    maxEdges: 5_000_000,
    seedQuery: 'm0'
  });
  assert.throws(
    () => createDenseFixturePlan({ fileCount: 10, methodsPerFile: 99_998 }),
    /million_node_fixture_node_count_invalid/u
  );

  const script = path.resolve('scripts/code-intelligence-million-node-index.mjs');
  const missingMode = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(missingMode.status, 2);
  assert.match(missingMode.stderr, /--plan\|--run/u);
  const planned = spawnSync(process.execPath, [script, '--plan'], { encoding: 'utf8' });
  assert.equal(planned.status, 0, planned.stderr);
  const planReceipt = JSON.parse(planned.stdout);
  assert.equal(planReceipt.requiresExplicitRun, true);
  assert.equal(planReceipt.fixture.expectedNodeCount, 1_000_000);
  assert.equal(planReceipt.fixture.seedQuery, 'm0');

  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-million-node-test-'));
  try {
    const plan = createDenseFixturePlan({ fileCount: 2, methodsPerFile: 3 });
    const first = await writeDenseFixture(root, plan);
    const source = await readFile(path.join(root, 'src', 'dense-0000.js'), 'utf8');
    const metadata = await stat(path.join(root, 'src', 'dense-0000.js'));
    assert.equal(first.fileCount, 2);
    assert.equal(first.expectedNodeCount, 12);
    assert.equal(first.expectedEdgeCount, 10);
    assert.equal(first.totalSourceBytes, metadata.size * 2);
    assert(metadata.size <= plan.maxFileBytes);
    assert.equal(source, 'class C{\nm0(){}\nm1(){}\nm2(){}\n}\n');

    const secondRoot = `${root}-copy`;
    try {
      const second = await writeDenseFixture(secondRoot, plan);
      assert.equal(first.ref, second.ref);
      assert.doesNotMatch(JSON.stringify(first), /(?:\/Users\/|\/home\/[^/]+\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\)/u);
    } finally {
      await rm(secondRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
