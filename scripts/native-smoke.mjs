import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SQLiteMemoryProvider } from '../providers/native/memory-sqlite/src/index.mjs';
import { FilesystemArtifactStore } from '../providers/native/artifact-filesystem/src/index.mjs';
import { DeterministicModelProvider } from '../providers/native/model-deterministic/src/index.mjs';
import { LocalIdentityStore } from '../providers/native/identity-local/src/index.mjs';
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

  console.log('PASS native SQLite memory');
  console.log('PASS content-addressed artifact store');
  console.log('PASS native local identity');
  console.log(`PASS Agent Pack ${pack.metadata.name}@${pack.metadata.version} ${fingerprint}`);
  console.log('PASS deterministic local model provider');
  console.log('Native provider smoke completed without network access.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
