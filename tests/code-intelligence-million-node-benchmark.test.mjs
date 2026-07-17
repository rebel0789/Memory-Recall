import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MILLION_NODE_PLAN,
  createDenseFixturePlan,
  runKillSafeProcess,
  writeDenseFixture
} from '../scripts/code-intelligence-million-node-index.mjs';

test('million-node benchmark plan and dense fixture are exact, bounded, and deterministic', async () => {
  assert.deepEqual(MILLION_NODE_PLAN, {
    language: 'javascript',
    shape: 'base36-empty-classes-v2',
    fileCount: 1_000,
    classesPerFile: 998,
    expectedNodeCount: 1_000_000,
    expectedEdgeCount: 999_000,
    maxFileBytes: 524_288,
    maxNodes: 1_000_000,
    maxEdges: 1_000_000,
    seedQuery: 'ScaleProbe'
  });
  assert.throws(
    () => createDenseFixturePlan({ fileCount: 1_000, classesPerFile: 999 }),
    /million_node_fixture_node_count_invalid/u
  );

  const script = path.resolve('scripts/code-intelligence-million-node-index.mjs');
  const missingMode = await runKillSafeProcess({
    command: process.execPath,
    args: [script],
    cwd: process.cwd(),
    timeoutMs: 2_000
  });
  assert.equal(missingMode.exitCode, 2);
  assert.match(missingMode.stderr.toString('utf8'), /--plan\|--run/u);
  const planned = await runKillSafeProcess({
    command: process.execPath,
    args: [script, '--plan'],
    cwd: process.cwd(),
    timeoutMs: 2_000
  });
  assert.equal(planned.exitCode, 0, planned.stderr.toString('utf8'));
  const planReceipt = JSON.parse(planned.stdout.toString('utf8'));
  assert.equal(planReceipt.requiresExplicitRun, true);
  assert.equal(planReceipt.reportVersion, 'memory-recall-million-node-rust-index-2');
  assert.equal(planReceipt.fixture.expectedNodeCount, 1_000_000);
  assert.equal(planReceipt.fixture.expectedEdgeCount, 999_000);
  assert.equal(planReceipt.fixture.seedQuery, 'ScaleProbe');
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-million-node-test-'));
  try {
    const plan = createDenseFixturePlan({ fileCount: 2, classesPerFile: 3 });
    const first = await writeDenseFixture(root, plan);
    const source = await readFile(path.join(root, 'src', 'dense-0000.js'), 'utf8');
    const secondSource = await readFile(path.join(root, 'src', 'dense-0001.js'), 'utf8');
    const metadata = await stat(path.join(root, 'src', 'dense-0000.js'));
    const secondMetadata = await stat(path.join(root, 'src', 'dense-0001.js'));
    assert.equal(first.fileCount, 2);
    assert.equal(first.shape, 'base36-empty-classes-v2');
    assert.equal(first.expectedNodeCount, 10);
    assert.equal(first.expectedEdgeCount, 8);
    assert.equal(first.totalSourceBytes, metadata.size + secondMetadata.size);
    assert(metadata.size <= plan.maxFileBytes);
    assert(secondMetadata.size <= plan.maxFileBytes);
    assert.equal(source, 'class ScaleProbe{}class C1{}class C2{}\n');
    assert.equal(secondSource, 'class C0{}class C1{}class C2{}\n');

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

test('kill-safe process reports direct-child RSS on timeout and kills descendants', {
  skip: !['darwin', 'linux'].includes(process.platform)
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-rss-timeout-test-'));
  try {
    const marker = path.join(root, 'orphan-survived');
    const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'), 600); setInterval(() => {}, 1000);`;
    const parent = `const held = Buffer.alloc(32 * 1024 * 1024, 1); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); setInterval(() => held[0], 1000);`;
    const timedOut = await runKillSafeProcess({
      command: process.execPath,
      args: ['-e', parent],
      cwd: root,
      timeoutMs: 300,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024
    });
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.exitCode, null);
    assert.match(timedOut.signal ?? '', /SIGKILL/u);
    assert.equal(timedOut.rssMeasurement, 'direct-child-ps-sampled');
    assert.equal(timedOut.rssSampleIntervalMs, 250);
    assert(timedOut.peakNativeRssMb > 0);
    assert.match(timedOut.stdoutSha256, /^sha256:[a-f0-9]{64}$/u);
    assert.match(timedOut.stderrSha256, /^sha256:[a-f0-9]{64}$/u);
    await new Promise((resolve) => setTimeout(resolve, 700));
    await assert.rejects(access(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
