import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { LocalIdentityStore } from '../providers/native/identity-local/src/index.mjs';
import { runAuthBootstrapCli } from '../scripts/auth-bootstrap.mjs';

const clock = () => '2026-06-19T10:00:00.000Z';
const password = 'correct horse battery staple';

async function tempStore(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-identity-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = await new LocalIdentityStore({
    directory: root,
    clock,
    scrypt: { N: 1024, r: 8, p: 1, keyLength: 32 }
  }).init();
  return { root, store };
}

test('bootstraps exactly one owner without storing raw credentials or secrets', async (t) => {
  const { root, store } = await tempStore(t);
  assert.equal(await store.isBootstrapped(), false);

  const first = await store.bootstrapOwner({
    username: 'owner',
    displayName: 'Local Owner',
    password,
    workspaceId: 'ws_local',
    workspaceName: 'Local Workspace'
  });
  assert.equal(first.user.username, 'owner');
  assert.equal(first.user.passwordCredential, undefined);
  assert.equal(first.workspace.id, 'ws_local');
  assert.equal(first.membership.role, 'owner');
  assert.equal(await store.isBootstrapped(), true);

  const [againA, againB] = await Promise.allSettled([
    store.bootstrapOwner({ username: 'owner2', displayName: 'Second', password, workspaceId: 'ws_second' }),
    store.bootstrapOwner({ username: 'owner3', displayName: 'Third', password, workspaceId: 'ws_third' })
  ]);
  assert.equal([againA, againB].filter((item) => item.status === 'rejected' && item.reason?.code === 'already_bootstrapped').length, 2);

  const data = await readFile(path.join(root, 'identity.json'), 'utf8');
  assert.equal(data.includes(password), false);
  assert.equal(data.includes('correct horse'), false);
  assert.match(data, /scrypt\$v1\$/);
  assert.equal(data.includes('oaf_ses_'), false);
  assert.equal(data.includes('oaf_tok_'), false);

  const rootMode = (await stat(root)).mode & 0o777;
  const fileMode = (await stat(path.join(root, 'identity.json'))).mode & 0o777;
  assert.equal(rootMode, 0o700);
  assert.equal(fileMode, 0o600);
});

test('password verification is strict, bounded, and safe for unknown usernames', async (t) => {
  const { store } = await tempStore(t);
  await store.bootstrapOwner({ username: 'owner', displayName: 'Local Owner', password, workspaceId: 'ws_local' });

  assert.equal((await store.verifyPassword({ username: 'owner', password })).ok, true);
  assert.equal((await store.verifyPassword({ username: 'owner', password: 'wrong password 12345' })).ok, false);
  assert.equal((await store.verifyPassword({ username: 'missing', password: 'wrong password 12345' })).ok, false);

  await assert.rejects(
    () => store.bootstrapOwner({ username: 'bad', displayName: 'Bad', password: 'short', workspaceId: 'ws_bad' }),
    /password must be at least 12 characters/
  );
  await assert.rejects(
    () => store.bootstrapOwner({ username: 'bad', displayName: 'Bad', password: `valid-password\u0000`, workspaceId: 'ws_bad' }),
    /password cannot contain null bytes/
  );
  await assert.rejects(
    () => store.bootstrapOwner({ username: 'bad', displayName: 'Bad', password: 'x'.repeat(300), workspaceId: 'ws_bad' }),
    /password must be at most 256 UTF-8 bytes/
  );
});

test('sessions, csrf secrets, and API tokens are hashed at rest and revocable', async (t) => {
  const { root, store } = await tempStore(t);
  const bootstrap = await store.bootstrapOwner({ username: 'owner', displayName: 'Local Owner', password, workspaceId: 'ws_local' });

  const session = await store.createSession({
    userId: bootstrap.user.id,
    remoteAddress: '127.0.0.1',
    userAgent: 'node:test'
  });
  assert.match(session.token, /^oaf_ses_[A-Za-z0-9_-]{43,}$/);
  assert.match(session.csrfToken, /^oaf_csrf_[A-Za-z0-9_-]{43,}$/);
  assert.equal((await store.authenticateSession({ token: session.token }))?.session.id, session.session.id);

  const apiToken = await store.createApiToken({
    actorUserId: bootstrap.user.id,
    name: 'local automation',
    workspaceIds: ['ws_local'],
    scopes: ['run.read', 'run.execute'],
    expiresAt: '2026-06-20T10:00:00.000Z'
  });
  assert.match(apiToken.token, /^oaf_tok_[A-Za-z0-9._:-]+_[A-Za-z0-9_-]{43,}$/);
  const listed = await store.listApiTokens({ userId: bootstrap.user.id });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].token, undefined);
  assert.equal(listed[0].tokenHash, undefined);
  assert.equal((await store.authenticateApiToken({ token: apiToken.token, now: '2026-06-19T10:00:00.000Z' }))?.apiToken.id, apiToken.apiToken.id);

  const data = await readFile(path.join(root, 'identity.json'), 'utf8');
  assert.equal(data.includes(session.token), false);
  assert.equal(data.includes(session.csrfToken), false);
  assert.equal(data.includes(apiToken.token), false);

  await store.revokeSession({ sessionId: session.session.id, actorUserId: bootstrap.user.id });
  assert.equal(await store.authenticateSession({ token: session.token }), null);
  await store.revokeApiToken({ tokenId: apiToken.apiToken.id, actorUserId: bootstrap.user.id });
  assert.equal(await store.authenticateApiToken({ token: apiToken.token, now: '2026-06-19T10:00:00.000Z' }), null);
});

test('local owner API-token minting is workspace-scoped and role-gated', async (t) => {
  const { store } = await tempStore(t);
  const bootstrap = await store.bootstrapOwner({ username: 'owner', displayName: 'Local Owner', password, workspaceId: 'ws_local' });
  const builder = await store.createUser({ username: 'builder', displayName: 'Builder', password });
  await store.putWorkspace({ id: 'ws_other', name: 'Other Workspace' });
  await store.putMembership({ userId: builder.user.id, workspaceId: 'ws_local', role: 'builder' });

  await assert.rejects(
    () => store.createApiToken({ actorUserId: builder.user.id, name: 'builder token', workspaceIds: ['ws_local'], scopes: ['run.read'] }),
    /owner membership required/
  );
  await assert.rejects(
    () => store.createApiToken({ actorUserId: bootstrap.user.id, name: 'cross workspace', workspaceIds: ['ws_other'], scopes: ['run.read'] }),
    /owner membership required/
  );
  assert.equal((await store.listApiTokens({ userId: builder.user.id })).length, 0);

  await store.putMembership({ userId: bootstrap.user.id, workspaceId: 'ws_other', role: 'owner' });
  const allowed = await store.createApiToken({ actorUserId: bootstrap.user.id, name: 'owner other', workspaceIds: ['ws_other'], scopes: ['run.read'] });
  assert.deepEqual(allowed.apiToken.workspaceIds, ['ws_other']);
});

test('auth bootstrap CLI accepts only stdin passwords and fails after bootstrap', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaf-auth-cli-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const run = async (args, input = '') => {
    let stdout = '';
    let stderr = '';
    const stdin = Readable.from([input]);
    const out = new Writable({ write(chunk, _encoding, callback) { stdout += chunk.toString(); callback(); } });
    const err = new Writable({ write(chunk, _encoding, callback) { stderr += chunk.toString(); callback(); } });
    const code = await runAuthBootstrapCli({ argv: args, stdin, stdout: out, stderr: err });
    return { code, stdout, stderr };
  };

  const rejected = await run(['--data-dir', root, '--username', 'owner', '--display-name', 'Local Owner', '--password', password]);
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stderr, /--password is not supported/);

  const created = await run(['--data-dir', root, '--username', 'owner', '--display-name', 'Local Owner', '--password-stdin'], `${password}\n`);
  assert.equal(created.code, 0, created.stderr);
  assert.match(created.stdout, /"workspaceId": "ws_local"/);
  assert.equal(created.stdout.includes(password), false);

  const second = await run(['--data-dir', root, '--username', 'other', '--display-name', 'Other', '--password-stdin'], `${password}\n`);
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /already_bootstrapped/);
});
