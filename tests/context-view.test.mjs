import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileAndPersistContext, compileContext, createContextView, verifyContextManifest } from '../packages/context-compiler/src/index.mjs';
import { validateJsonSchema } from '../packages/protocol/src/schema-validator.mjs';

const fixedNow = '2026-07-03T00:00:00.000Z';
const schema = JSON.parse(readFileSync('packages/protocol/schemas/context-manifest.schema.json', 'utf8'));

function repo() {
  const rows = new Map();
  return {
    async append({ workspaceId, manifest }) {
      rows.set(`${workspaceId}:${manifest.id}`, manifest);
      return manifest;
    },
    async get({ workspaceId, id }) {
      return rows.get(`${workspaceId}:${id}`) ?? null;
    }
  };
}

function request(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    id: 'ctxreq_context_view',
    requestId: 'ctxreq_context_view',
    correlationId: 'req_context_view_000000',
    workspaceId: 'ws_local',
    actorId: 'usr_owner',
    taskId: 'task_context_view',
    step: 'inspect compressed tool output',
    objective: 'Find authentication failure context from tool output',
    requiredIds: ['obs_tool_output'],
    requiredEntities: ['topic:auth'],
    allowedScopes: ['workspace-private'],
    allowedDataClasses: ['workspace-private'],
    allowedTrustClasses: ['observed', 'verified'],
    tokenBudget: 120,
    now: fixedNow,
    trustedTimestamp: fixedNow,
    ...overrides
  };
}

function noisyLog() {
  const filler = Array.from({ length: 80 }, (_, index) => `debug ${index}: heartbeat session cache warm`).join('\n');
  return [
    '2026-07-03T00:00:00Z info starting auth workflow',
    'token=super-secret-value /Users/rebel/private.env',
    filler,
    '2026-07-03T00:00:03Z ERROR authentication failure: session expired',
    '2026-07-03T00:00:04Z WARN retry failed after token refresh',
    '2026-07-03T00:00:05Z info finished with failure'
  ].join('\n');
}

test('explicit context views compact noisy tool output and keep original retrieval proof', async () => {
  const raw = noisyLog();
  const view = createContextView(raw, { contentKind: 'log', maxTokens: 80 });
  assert(view.viewTokens < view.originalTokens);
  assert(!view.text.includes('super-secret-value'));
  assert(!view.text.includes('/Users/rebel'));

  const compiled = compileContext(request(), [{
    id: 'obs_tool_output',
    kind: 'observation',
    workspaceId: 'ws_local',
    text: raw,
    tags: ['topic:auth'],
    relations: ['topic:auth'],
    scope: 'workspace-private',
    dataClass: 'workspace-private',
    trustClass: 'observed',
    status: 'active',
    source: 'tool-output',
    tokens: view.originalTokens,
    metadata: { contextView: { enabled: true, contentKind: 'log', maxTokens: 80 } }
  }]);
  const selected = compiled.selected.find((item) => item.id === 'obs_tool_output');
  assert(selected);
  assert.equal(selected.contentHash, selected.contextView.originalContentHash);
  assert.equal(selected.contextView.viewTokens, selected.tokens);
  assert(selected.contextView.reductionRatio > 0.6);
  assert(selected.representationHint.reasonCodes.includes('original_recoverable_by_hash'));
  assert(!selected.text.includes('super-secret-value'));
  assert(!selected.text.includes('/Users/rebel'));
  assert.equal(validateJsonSchema(schema, compiled).valid, true);

  const persisted = await compileAndPersistContext(request(), [{
    id: 'obs_tool_output',
    kind: 'observation',
    workspaceId: 'ws_local',
    text: raw,
    tags: ['topic:auth'],
    relations: ['topic:auth'],
    scope: 'workspace-private',
    dataClass: 'workspace-private',
    trustClass: 'observed',
    status: 'active',
    source: 'tool-output',
    tokens: view.originalTokens,
    metadata: { contextView: { enabled: true, contentKind: 'log', maxTokens: 80 } }
  }], { manifestRepository: repo(), runId: 'run_context_view', clock: () => fixedNow });

  assert.equal(verifyContextManifest(persisted.manifest).valid, true);
  assert(persisted.manifest.assembly.originalTokens > persisted.manifest.assembly.totalTokens);
  assert(persisted.manifest.tokenAccounting.wastedTokenEstimate > 0);
  assert(persisted.manifest.tokenAccounting.compressionLossNotes.some((item) => item.recordId === 'obs_tool_output' && item.tier === 'context-view'));
});
