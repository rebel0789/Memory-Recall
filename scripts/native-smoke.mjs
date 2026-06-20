import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStateStore } from '../packages/storage/src/file-store.mjs';
import { SQLiteMemoryProvider } from '../providers/native/memory-sqlite/src/index.mjs';
import { FilesystemArtifactStore } from '../providers/native/artifact-filesystem/src/index.mjs';
import { DeterministicModelProvider } from '../providers/native/model-deterministic/src/index.mjs';
import { LocalIdentityStore } from '../providers/native/identity-local/src/index.mjs';
import { DeterministicPolicyProvider } from '../providers/native/policy-deterministic/src/index.mjs';
import { FilesystemContextManifestRepository } from '../providers/native/context-manifest-local/src/index.mjs';
import { DurableSQLiteWorkflowRuntime, createDurableSmokeWorkflowDefinition, createDurableSmokeWorkflowRegistry } from '../providers/native/workflow-durable-sqlite/src/index.mjs';
import { BrokeredLocalToolProvider } from '../providers/native/tool-brokered-local/src/index.mjs';
import { createNativeExactCandidateSource } from '../providers/native/context-candidate-exact/src/index.mjs';
import { createNativeLexicalCandidateSource } from '../providers/native/context-candidate-lexical/src/index.mjs';
import { compileAndPersistContext, createCandidateSourceRegistry, createFixtureRecordReader, generateContextCandidates } from '../packages/context-compiler/src/index.mjs';
import { createMemoryEffectBoundary } from '../packages/tool-registry/src/index.mjs';
import { fingerprintAgentPack, validateAgentPack } from '../packages/agentpack/src/index.mjs';
import { createOperationsBackup, restoreOperationsBackup, verifyOperationsBackup } from '../packages/operations/src/index.mjs';

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

  let durableNow = Date.parse('2026-06-20T00:00:00.000Z');
  const durableClock = () => new Date(durableNow).toISOString();
  const durableDefinition = createDurableSmokeWorkflowDefinition();
  const durable = new DurableSQLiteWorkflowRuntime({
    dataRoot: path.join(directory, 'workflows durable'),
    registry: createDurableSmokeWorkflowRegistry(),
    clock: durableClock,
    leaseMs: 10
  });
  await durable.registerWorkflow(durableDefinition);
  await durable.start({
    workspaceId: 'ws_smoke',
    workflowId: durableDefinition.id,
    workflowVersion: durableDefinition.version,
    runId: 'run_native_durable_smoke',
    input: { objective: 'native durable smoke' }
  });
  await durable.tick({ workerId: 'worker_native_a' });
  await durable.tick({ workerId: 'worker_native_a' });
  durable.close();
  const recoveredDurable = new DurableSQLiteWorkflowRuntime({
    dataRoot: path.join(directory, 'workflows durable'),
    registry: createDurableSmokeWorkflowRegistry(),
    clock: durableClock,
    leaseMs: 10
  });
  durableNow += 100;
  await recoveredDurable.tick({ workerId: 'worker_native_b' });
  await recoveredDurable.tick({ workerId: 'worker_native_b' });
  durableNow += 1000;
  await recoveredDurable.tick({ workerId: 'worker_native_b' });
  const durableWaiting = await recoveredDurable.get({ workspaceId: 'ws_smoke', runId: 'run_native_durable_smoke' });
  await recoveredDurable.resolveApproval({
    workspaceId: 'ws_smoke',
    runId: 'run_native_durable_smoke',
    approvalId: durableWaiting.steps.approval.approvalId,
    actorId: bootstrap.user.id,
    decision: 'approved',
    operationFingerprint: 'sha256:approval-smoke'
  });
  await recoveredDurable.runWorker({ workerId: 'worker_native_b', maxTicks: 10, idleMs: 1 });
  const durableRun = await recoveredDurable.get({ workspaceId: 'ws_smoke', runId: 'run_native_durable_smoke' });
  const durableHistory = await recoveredDurable.history({ workspaceId: 'ws_smoke', runId: 'run_native_durable_smoke' });
  if (durableRun.status !== 'completed' || durableRun.output.effect.effectCount !== 1 || !durableHistory.events.some((event) => event.type === 'run.resumed')) {
    throw new Error('native durable workflow smoke failed');
  }
  recoveredDurable.close();

  const operationsState = await new FileStateStore(path.join(directory, 'ops-state')).init();
  await operationsState.update((state) => {
    state.runs.push({ id: 'run_native_ops_smoke', workspaceId: 'ws_smoke', status: 'completed' });
    state.events.push({ id: 'evt_native_ops_1', runId: 'run_native_ops_smoke', sequence: 1, type: 'run.started' });
    state.events.push({ id: 'evt_native_ops_2', runId: 'run_native_ops_smoke', sequence: 2, type: 'run.completed' });
    return state;
  });
  const operationsBackup = await createOperationsBackup({
    workspaceId: 'ws_smoke',
    destination: path.join(directory, 'ops-backup'),
    stateStore: operationsState,
    artifactStore: artifacts,
    migrationStatus: {
      ok: true,
      ledgerTable: 'oaf_schema_migrations',
      plan: [{ version: 1, name: 'init', filename: '001_init.sql', checksum: '1'.repeat(64), state: 'applied' }],
      appliedMigrations: [{ version: 1, name: 'init', checksum: '1'.repeat(64), appliedAt: '2026-06-20T00:00:00.000Z' }]
    },
    appVersion: '0.2.0-dev',
    deploymentProfile: 'bootstrap',
    createdAt: '2026-06-20T00:00:00.000Z'
  });
  if (!operationsBackup.ok || !(await verifyOperationsBackup({ source: operationsBackup.backupRoot, appVersion: '0.2.0-dev' })).ok) {
    throw new Error('native operations backup verification failed');
  }
  const restoredOperationsArtifacts = new FilesystemArtifactStore({ root: path.join(directory, 'ops-restored-artifacts') });
  const operationsRestore = await restoreOperationsBackup({
    source: operationsBackup.backupRoot,
    stateDirectory: path.join(directory, 'ops-restored-state'),
    artifactStore: restoredOperationsArtifacts,
    appVersion: '0.2.0-dev'
  });
  if (!operationsRestore.ok || (await restoredOperationsArtifacts.get({ workspaceId: 'ws_smoke', id: stored.id })).body.toString('utf8') !== 'smoke artifact') {
    throw new Error('native operations restore failed');
  }

  const toolWorkspaceRoot = path.join(directory, 'tool workspace with spaces');
  await mkdir(path.join(toolWorkspaceRoot, 'docs'), { recursive: true });
  await writeFile(path.join(toolWorkspaceRoot, 'docs', 'input.txt'), 'native bounded tool');
  const toolProvider = await BrokeredLocalToolProvider.fromCatalog({
    catalogPath: 'tools/catalog.json',
    manifestRoot: process.cwd(),
    workspaceRoot: toolWorkspaceRoot,
    clock: () => '2026-06-19T10:00:00.000Z'
  });
  const trustedToolContext = {
    principal: { userId: bootstrap.user.id, principalType: 'agent', authenticationMethod: 'session', status: 'active', agentRole: 'agent:security-auditor' },
    membership: { workspaceId: 'ws_smoke', role: 'builder', status: 'active' },
    environment: { deploymentProfile: 'local-dev', locality: 'local-only', interactive: true, externalWritesEnabled: false }
  };
  const toolBase = {
    schemaVersion: '1.0.0',
    correlationId: 'req_native-tool-smoke-000000',
    workspaceId: 'ws_smoke',
    runId: 'run_native_tool_smoke',
    stepId: 'step_native_tool_smoke',
    actorId: bootstrap.user.id,
    trustedContext: trustedToolContext,
    toolVersion: '1.0.0',
    dataClass: 'workspace-private',
    trustedTimestamp: '2026-06-19T10:00:00.000Z'
  };
  const toolRead = await toolProvider.execute({
    ...toolBase,
    requestId: 'toolreq_native_read',
    toolId: 'tool:filesystem-read',
    operation: 'readFile',
    input: { path: 'docs/input.txt' }
  });
  if (toolRead.status !== 'completed' || toolRead.output.byteSize !== 19) throw new Error('native brokered tool read smoke failed');
  const toolEffects = createMemoryEffectBoundary();
  const toolWrite = await toolProvider.execute({
    ...toolBase,
    requestId: 'toolreq_native_write',
    toolId: 'tool:workspace-write',
    operation: 'writeFile',
    input: { path: 'docs/output.txt', content: 'native bounded write' },
    idempotencyKey: 'idem_native_tool_write',
    effectBoundary: toolEffects
  });
  if (toolWrite.status !== 'completed' || toolEffects.count() !== 1) throw new Error('native brokered tool write smoke failed');

  console.log('PASS native SQLite memory');
  console.log('PASS content-addressed artifact store');
  console.log('PASS native local identity');
  console.log('PASS deterministic contextual policy provider');
  console.log('PASS native exact and lexical context candidate sources');
  console.log('PASS native local context manifest repository');
  console.log('PASS native durable SQLite workflow recovery');
  console.log('PASS native operations backup and restore');
  console.log('PASS native brokered bounded tool execution');
  console.log(`PASS Agent Pack ${pack.metadata.name}@${pack.metadata.version} ${fingerprint}`);
  console.log('PASS deterministic local model provider and gateway profile');
  console.log('Native provider smoke completed without network access.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
