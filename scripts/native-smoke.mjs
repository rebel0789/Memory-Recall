import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SQLiteMemoryProvider } from '../providers/native/memory-sqlite/src/index.mjs';
import { FilesystemArtifactStore } from '../providers/native/artifact-filesystem/src/index.mjs';
import { DeterministicModelProvider } from '../providers/native/model-deterministic/src/index.mjs';
import { LocalIdentityStore } from '../providers/native/identity-local/src/index.mjs';
import { DeterministicPolicyProvider } from '../providers/native/policy-deterministic/src/index.mjs';
import { FilesystemContextManifestRepository } from '../providers/native/context-manifest-local/src/index.mjs';
import { createNativeExactCandidateSource } from '../providers/native/context-candidate-exact/src/index.mjs';
import { createNativeLexicalCandidateSource } from '../providers/native/context-candidate-lexical/src/index.mjs';
import { compileAndPersistContext, createCandidateSourceRegistry, createFixtureRecordReader, generateContextCandidates } from '../packages/context-compiler/src/index.mjs';
import { fingerprintAgentPack, validateAgentPack } from '../packages/agentpack/src/index.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'oaf-native-smoke-'));
try {
  const memory = new SQLiteMemoryProvider({ filename: path.join(directory, 'memory.sqlite') });
  await memory.put({ workspaceId: 'ws_smoke', kind: 'decision', text: 'Every model call records a context manifest', source: 'test', status: 'active', tags: ['context'] });
  const candidates = await memory.queryCandidates({ workspaceId: 'ws_smoke', query: 'context manifest' });
  if (candidates.length !== 1) throw new Error('native memory smoke query failed');
  memory.close();

  const artifacts = new FilesystemArtifactStore({ root: path.join(directory, 'artifacts') });
  const stored = await artifacts.put({ workspaceId: 'ws_smoke', body: 'smoke artifact', mediaType: 'text/plain' });
  const loaded = await artifacts.get({ workspaceId: 'ws_smoke', id: stored.id });
  if (loaded.body.toString('utf8') !== 'smoke artifact') throw new Error('native artifact smoke read failed');

  const pack = validateAgentPack(JSON.parse(await readFile('examples/agentpacks/content-intelligence.agentpack.json', 'utf8')));
  const fingerprint = fingerprintAgentPack(pack);
  if (!fingerprint.startsWith('sha256:')) throw new Error('Agent Pack fingerprint failed');

  const model = new DeterministicModelProvider();
  const health = await model.health();
  if (health.status !== 'healthy') throw new Error('deterministic model provider unhealthy');
  const profile = model.profile();
  if (profile.providerId !== 'provider:native:model:deterministic' || profile.capabilities.structuredOutput !== true) {
    throw new Error('deterministic model gateway profile failed');
  }

  const identity = await new LocalIdentityStore({
    directory: path.join(directory, 'identity'),
    scrypt: { N: 1024, r: 8, p: 1, keyLength: 32 }
  }).init();
  const bootstrap = await identity.bootstrapOwner({
    username: 'owner',
    displayName: 'Local Owner',
    password: 'correct horse battery staple',
    workspaceId: 'ws_smoke',
    workspaceName: 'Smoke Workspace'
  });
  const verified = await identity.verifyPassword({ username: 'owner', password: 'correct horse battery staple' });
  if (!verified.ok || bootstrap.membership.role !== 'owner') throw new Error('native identity smoke failed');

  const policy = new DeterministicPolicyProvider({
    clock: () => '2026-06-19T10:00:00.000Z',
    decisionIdFactory: () => 'poldet_smoke'
  });
  const policyDecision = await policy.evaluate({
    schemaVersion: '1.0.0',
    requestId: 'polreq_smoke',
    correlationId: 'req_native-smoke-000000',
    operationId: 'nativeSmokePolicy',
    principal: { userId: bootstrap.user.id, principalType: 'user', authenticationMethod: 'session', status: 'active' },
    workspaceId: 'ws_smoke',
    membership: { workspaceId: 'ws_smoke', role: 'owner', status: 'active' },
    action: 'run.read',
    resource: { type: 'run', id: 'run_smoke', workspaceId: 'ws_smoke', dataClass: 'workspace-private' },
    environment: { deploymentProfile: 'local-dev', locality: 'local-only', interactive: true, externalWritesEnabled: false },
    trustedTimestamp: '2026-06-19T10:00:00.000Z'
  });
  if (policyDecision.outcome !== 'allow') throw new Error('native policy smoke failed');

  const candidateRegistry = createCandidateSourceRegistry([
    createNativeExactCandidateSource(),
    createNativeLexicalCandidateSource()
  ]);
  const candidateGeneration = await generateContextCandidates({
    schemaVersion: '1.0.0',
    requestId: 'ccreq_smoke',
    correlationId: 'req_native-smoke-000001',
    workspaceId: 'ws_smoke',
    actorId: bootstrap.user.id,
    taskId: 'task_smoke',
    objective: 'Find context manifest evidence',
    step: 'compile safe local context candidates',
    requiredIds: ['mem_smoke_context'],
    requiredEntities: ['context-manifest'],
    allowedDataClasses: ['workspace-private'],
    allowedTrustClasses: ['observed'],
    perSourceLimit: 5,
    totalCandidateLimit: 5,
    trustedTimestamp: '2026-06-19T10:00:00.000Z',
    tokenBudget: 64
  }, {
    registry: candidateRegistry,
    recordReader: createFixtureRecordReader([{
      id: 'mem_smoke_context',
      version: 'v1',
      workspaceId: 'ws_smoke',
      kind: 'policy',
      text: 'Every model call records a context manifest for safe local context.',
      tags: ['context-manifest'],
      source: 'smoke',
      dataClass: 'workspace-private',
      scope: 'workspace-private',
      trustClass: 'observed',
      updatedAt: '2026-06-19T10:00:00.000Z'
    }]),
    policyService: policy,
    trustedContext: {
      principal: { userId: bootstrap.user.id, principalType: 'user', authenticationMethod: 'session', status: 'active' },
      membership: { workspaceId: 'ws_smoke', role: 'owner', status: 'active' },
      environment: { deploymentProfile: 'local-dev', locality: 'local-only', interactive: true, externalWritesEnabled: false }
    },
    clock: () => '2026-06-19T10:00:00.000Z'
  });
  if (!candidateGeneration.candidates.some((candidate) => candidate.record.id === 'mem_smoke_context')) throw new Error('native context candidate smoke failed');

  const manifestStore = new FilesystemContextManifestRepository({ root: path.join(directory, 'context-manifests'), clock: () => '2026-06-19T10:00:00.000Z' });
  const persisted = await compileAndPersistContext({
    schemaVersion: '1.0.0',
    id: 'ctxreq_smoke_manifest',
    requestId: 'ctxreq_smoke_manifest',
    correlationId: 'req_native-smoke-000002',
    workspaceId: 'ws_smoke',
    actorId: bootstrap.user.id,
    taskId: 'task_smoke',
    objective: 'Find context manifest evidence',
    step: 'persist context assembly',
    requiredIds: ['mem_smoke_context'],
    requiredEntities: ['context-manifest'],
    allowedScopes: ['workspace-private'],
    allowedDataClasses: ['workspace-private'],
    allowedTrustClasses: ['observed'],
    tokenBudget: 64,
    now: '2026-06-19T10:00:00.000Z',
    trustedTimestamp: '2026-06-19T10:00:00.000Z'
  }, [{
    id: 'mem_smoke_context',
    version: 'v1',
    workspaceId: 'ws_smoke',
    kind: 'policy',
    text: 'Every model call records a context manifest for safe local context.',
    tags: ['context-manifest'],
    relations: ['context-manifest'],
    source: 'smoke',
    dataClass: 'workspace-private',
    scope: 'workspace-private',
    trustClass: 'observed',
    status: 'active',
    tokens: 14
  }], {
    manifestRepository: manifestStore,
    runId: 'run_smoke',
    clock: () => '2026-06-19T10:00:00.000Z'
  });
  if (!persisted.verification.valid) throw new Error('native context manifest smoke failed');

  console.log('PASS native SQLite memory');
  console.log('PASS content-addressed artifact store');
  console.log('PASS native local identity');
  console.log('PASS deterministic contextual policy provider');
  console.log('PASS native exact and lexical context candidate sources');
  console.log('PASS native local context manifest repository');
  console.log(`PASS Agent Pack ${pack.metadata.name}@${pack.metadata.version} ${fingerprint}`);
  console.log('PASS deterministic local model provider and gateway profile');
  console.log('Native provider smoke completed without network access.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
