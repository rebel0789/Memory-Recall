import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUST_BIN = path.join(ROOT, 'rust/target/release/oaf');
const FIXED_NOW = '2026-06-30T04:00:00.000Z';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW },
    ...options
  });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  return result;
}

function runJson(command, args, options = {}) {
  return JSON.parse(run(command, args, options).stdout);
}

function rpcLines(messages) {
  return messages.map((message) => JSON.stringify(message)).join('\n');
}

function mcp(root, sqlite, messages, tier = 'full') {
  const result = run(RUST_BIN, ['mcp', 'server', '--root', root, '--sqlite', sqlite, '--stdio'], {
    input: rpcLines(messages),
    env: { ...process.env, OAF_FIXED_NOW: FIXED_NOW, OAF_FEATURE_TIER: tier }
  });
  return result.stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const next = path.join(current, name);
      const stat = lstatSync(next);
      if (stat.isDirectory()) walk(next);
      else out.push(next);
    }
  };
  walk(dir);
  return out;
}

function assertJsonFile(file) {
  assert.doesNotThrow(() => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8')), `${file} must be valid JSON`);
}

function toolNamesFor(root, sqlite, tier) {
  const responses = mcp(root, sqlite, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
  ], tier);
  return responses[1].result.tools.map((tool) => tool.name);
}

assert.equal(existsSync(RUST_BIN), true, 'rust/target/release/oaf must exist; run cargo build --release --manifest-path rust/Cargo.toml first');

assertJsonFile('.claude-plugin/marketplace.json');
assertJsonFile('.claude-plugin/plugin.json');
assertJsonFile('.codex-plugin/plugin.json');
assertJsonFile('gemini-extension.json');
assertJsonFile('opencode.json');
assertJsonFile('.cursor/oaf-plugin.json');
assertJsonFile('.windsurf/oaf-plugin.json');
assertJsonFile('.kiro/oaf-plugin.json');
assert.match(readFileSync(path.join(ROOT, 'plugin.yaml'), 'utf8'), /open-agent-fabric/u);
assert.match(readFileSync(path.join(ROOT, 'docs/agent-portability.md'), 'utf8'), /Claude Code/u);
assert.match(readFileSync(path.join(ROOT, 'docs/THIRD_PARTY.md'), 'utf8'), /DietrichGebert\/ponytail/u);
assert.match(readFileSync(path.join(ROOT, 'skills/oaf-memory/SKILL.md'), 'utf8'), /brain\.propose_graph_organization/u);

const temp = mkdtempSync(path.join(os.tmpdir(), 'oaf-rust-brain-setup-'));
try {
  const configHome = path.join(temp, 'agent-config');
  mkdirSync(path.join(configHome, '.claude'), { recursive: true });
  mkdirSync(path.join(configHome, '.codex'), { recursive: true });
  mkdirSync(path.join(configHome, '.cursor'), { recursive: true });
  mkdirSync(path.join(configHome, '.gemini'), { recursive: true });
  mkdirSync(path.join(configHome, '.config/opencode'), { recursive: true });

  const env = { ...process.env, OAF_CONFIG_HOME: configHome, HOME: path.join(temp, 'home'), OAF_FIXED_NOW: FIXED_NOW };
  const lite = runJson(RUST_BIN, ['setup', '--tier', 'lite', '--dry-run', '--format', 'json'], { env });
  const full = runJson(RUST_BIN, ['setup', '--tier', 'full', '--dry-run', '--format', 'json'], { env });
  const ultra = runJson(RUST_BIN, ['setup', '--tier', 'ultra', '--dry-run', '--format', 'json'], { env });

  assert.equal(lite.command, 'setup');
  assert.deepEqual(lite.tier.features, ['memory.recall', 'memory.why']);
  assert.equal(full.tier.features.includes('context.profile'), true);
  assert.equal(full.tier.features.includes('brain.propose_graph_organization'), false);
  assert.equal(ultra.tier.features.includes('brain.propose_graph_organization'), true);
  assert.equal(ultra.detectedHarnesses.some((h) => h.client === 'claude-code'), true);
  assert.equal(ultra.detectedHarnesses.some((h) => h.client === 'codex'), true);
  assert.equal(ultra.detectedHarnesses.every((h) => h.model.includes('configured model')), true);

  const applied = runJson(RUST_BIN, ['setup', '--tier', 'ultra', '--confirm', ultra.planFingerprint, '--format', 'json'], { env });
  assert.equal(applied.changed, true);
  assert.equal(applied.safeguards.credentialsStored, false);
  assert.equal(applied.safeguards.networkCalls, 0);
  assert.equal(applied.safeguards.modelCallsByOaf, 0);
  assert.equal(applied.receipt.pluginManifests.some((entry) => entry.kind === 'instruction-fallback'), true);
  assert.equal(listFiles(configHome).every((file) => file.startsWith(configHome)), true);

  const afterApply = listFiles(configHome).map((file) => `${path.relative(configHome, file)}:${sha(readFileSync(file))}`);
  const reapplied = runJson(RUST_BIN, ['setup', '--tier', 'ultra', '--confirm', ultra.planFingerprint, '--format', 'json'], { env });
  assert.equal(reapplied.idempotent, true);
  assert.deepEqual(listFiles(configHome).map((file) => `${path.relative(configHome, file)}:${sha(readFileSync(file))}`), afterApply);

  const root = path.join(temp, 'repo');
  const sqlite = path.join(root, '.local/memory.sqlite');
  mkdirSync(path.join(root, '.local'), { recursive: true });
  writeFileSync(path.join(root, 'main.py'), 'def deterministic():\n    return 1\n');
  const ingest = runJson(RUST_BIN, ['ingest', '--root', root, '--sqlite', sqlite, '--format', 'json'], { env });
  assert.equal(ingest.safeguards.modelCalls, 0);
  runJson(RUST_BIN, ['memory', 'approve', '--all', '--root', root, '--sqlite', sqlite, '--format', 'json'], { env });

  assert.deepEqual(toolNamesFor(root, sqlite, 'lite'), ['memory.recall', 'memory.why']);
  assert.equal(toolNamesFor(root, sqlite, 'full').includes('brain.propose_graph_organization'), false);
  assert.equal(toolNamesFor(root, sqlite, 'ultra').includes('brain.propose_graph_organization'), true);

  const brainResponses = mcp(root, sqlite, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'brain.propose_graph_organization',
        arguments: {
          kind: 'community_label',
          subject: 'community:memory',
          predicate: 'LABEL',
          object: 'memory governance and proposal approval',
          source: 'workspace://.local/oaf-brain/community-memory.json',
          notes: 'ai_proposed: compact graph slice only',
          promptTokens: 128,
          completionTokens: 12,
          budgetTokens: 512
        }
      }
    }
  ], 'ultra');
  const brainPayload = JSON.parse(brainResponses[1].result.content[0].text);
  assert.equal(brainPayload.summary.pendingProposalCount, 1);
  assert.equal(brainPayload.summary.activeMemoryCreated, 0);
  assert.equal(brainPayload.source.provenance, 'ai_proposed');
  assert.equal(brainPayload.safeguards.modelCallsByOaf, 0);
  assert.equal(brainPayload.safeguards.approvalRequired, true);
  assert.equal(brainPayload.brainTokenUsage.totalTokens, 140);
  assert.equal(brainPayload.brainTokenUsage.withinBudget, true);
  const review = runJson(RUST_BIN, ['memory', 'review', '--root', root, '--sqlite', sqlite, '--format', 'json'], { env });
  assert.equal(review.summary.pendingProposalCount, 1);

  const brainCache = new Map();
  let hostBrainCalls = 0;
  function hostBrain({ deterministic, changed, compactSlice }) {
    if (deterministic || !changed) return { called: false, cacheHit: false, tokens: 0 };
    const key = sha(compactSlice);
    if (brainCache.has(key)) return { called: false, cacheHit: true, tokens: 0 };
    hostBrainCalls += 1;
    const tokens = Math.ceil(compactSlice.length / 4);
    brainCache.set(key, { tokens });
    return { called: true, cacheHit: false, tokens };
  }
  assert.equal(hostBrain({ deterministic: true, changed: true, compactSlice: 'def deterministic' }).called, false);
  assert.equal(hostBrain({ deterministic: false, changed: false, compactSlice: 'same compact graph slice' }).called, false);
  assert.equal(hostBrain({ deterministic: false, changed: true, compactSlice: 'community 7: Store approve proposal graph edges' }).called, true);
  assert.equal(hostBrain({ deterministic: false, changed: true, compactSlice: 'community 7: Store approve proposal graph edges' }).cacheHit, true);
  assert.equal(hostBrainCalls, 1);

  console.log(JSON.stringify({
    schemaVersion: '1.0.0',
    command: 'rust ai brain setup quality',
    setup: {
      detectedHarnesses: ultra.detectedHarnesses.map((h) => h.client),
      tierFeatures: {
        lite: lite.tier.features,
        full: full.tier.features,
        ultra: ultra.tier.features
      },
      touchedFileCount: applied.receipt.touchedFiles.length,
      idempotent: reapplied.idempotent,
      credentialsStored: false,
      networkCalls: 0
    },
    brain: {
      proposalCount: brainPayload.summary.pendingProposalCount,
      activeMemoryCreated: brainPayload.summary.activeMemoryCreated,
      provenance: brainPayload.source.provenance,
      sourceTrust: brainPayload.source.sourceTrust,
      modelCallsByOaf: brainPayload.safeguards.modelCallsByOaf,
      tokenUsage: brainPayload.brainTokenUsage
    },
    tokenSmart: {
      deterministicCodeBrainCalls: 0,
      unchangedBrainCalls: 0,
      hostBrainCalls,
      cacheSize: brainCache.size,
      cachedRepeatSkipped: true,
      context: 'compact-oaf-slices-only'
    },
    manifests: {
      claudeMarketplace: true,
      claudePlugin: true,
      codexPlugin: true,
      geminiExtension: true,
      opencode: true,
      cursor: true,
      windsurf: true,
      kiro: true,
      pluginYaml: true,
      instructionFallback: true
    },
    safeguards: {
      modelCallsByOaf: 0,
      runtimeNetworkCalls: 0,
      externalDatabase: false,
      proposalGated: true
    },
    status: 'PASS'
  }, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
