import { createHash, randomBytes as nodeRandomBytes, randomUUID, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

export const LOCAL_IDENTITY_PROVIDER_ID = 'provider:native:identity:local';

const scryptAsync = promisify(nodeScrypt);
const USERNAME_PATTERN = /^[a-zA-Z0-9._:-]{1,80}$/;
const WORKSPACE_PATTERN = /^ws_[A-Za-z0-9._:-]{1,120}$/;
const TOKEN_SECRET_BYTES = 32;
const DEFAULT_SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1, keyLength: 32 });
const ROLE_VALUES = new Set(['owner', 'builder', 'operator', 'auditor']);

function identityError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function initialState() {
  return {
    schemaVersion: '1.0.0',
    users: [],
    workspaces: [],
    memberships: [],
    sessions: [],
    apiTokens: [],
    auditEvents: []
  };
}

function nowIso() {
  return new Date().toISOString();
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function normalizeUsername(value) {
  if (typeof value !== 'string' || !USERNAME_PATTERN.test(value)) throw identityError('invalid_username', 'username is invalid');
  return value.toLowerCase();
}

function assertWorkspaceId(value) {
  if (typeof value !== 'string' || !WORKSPACE_PATTERN.test(value)) throw identityError('invalid_workspace', 'workspaceId is invalid');
  return value;
}

function assertDisplayName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 120) throw identityError('invalid_display_name', 'displayName is invalid');
  return value;
}

export function assertPasswordPolicy(password) {
  if (typeof password !== 'string') throw new TypeError('password must be a string');
  if (password.includes('\u0000')) throw new Error('password cannot contain null bytes');
  if (password.length < 12) throw new Error('password must be at least 12 characters');
  if (Buffer.byteLength(password, 'utf8') > 256) throw new Error('password must be at most 256 UTF-8 bytes');
  return password;
}

function scryptOptions(input = {}) {
  const N = Number(input.N ?? DEFAULT_SCRYPT.N);
  const r = Number(input.r ?? DEFAULT_SCRYPT.r);
  const p = Number(input.p ?? DEFAULT_SCRYPT.p);
  const keyLength = Number(input.keyLength ?? DEFAULT_SCRYPT.keyLength);
  if (!Number.isInteger(N) || N < 1024 || (N & (N - 1)) !== 0) throw new TypeError('scrypt.N must be a power of two >= 1024');
  if (!Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1 || !Number.isInteger(keyLength) || keyLength < 16) throw new TypeError('invalid scrypt parameters');
  return { N, r, p, keyLength };
}

async function hashPassword(password, options) {
  assertPasswordPolicy(password);
  const salt = nodeRandomBytes(16);
  const key = await scryptAsync(password, salt, options.keyLength, { N: options.N, r: options.r, p: options.p, maxmem: Math.max(32 * 1024 * 1024, 256 * options.N * options.r) });
  return `scrypt$v1$${options.N}$${options.r}$${options.p}$${base64url(salt)}$${base64url(key)}`;
}

function parseCredential(value) {
  const parts = String(value ?? '').split('$');
  if (parts.length !== 7 || parts[0] !== 'scrypt' || parts[1] !== 'v1') throw identityError('invalid_credential', 'password credential is invalid');
  return {
    N: Number(parts[2]),
    r: Number(parts[3]),
    p: Number(parts[4]),
    salt: Buffer.from(parts[5], 'base64url'),
    key: Buffer.from(parts[6], 'base64url')
  };
}

async function verifyCredential(password, credential) {
  assertPasswordPolicy(password);
  const parsed = parseCredential(credential);
  const key = await scryptAsync(password, parsed.salt, parsed.key.length, { N: parsed.N, r: parsed.r, p: parsed.p, maxmem: Math.max(32 * 1024 * 1024, 256 * parsed.N * parsed.r) });
  if (key.length !== parsed.key.length) return false;
  return timingSafeEqual(key, parsed.key);
}

function safeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function safeWorkspace(workspace) {
  if (!workspace) return null;
  return {
    id: workspace.id,
    name: workspace.name,
    createdAt: workspace.createdAt
  };
}

function safeMembership(membership) {
  if (!membership) return null;
  return {
    id: membership.id,
    userId: membership.userId,
    workspaceId: membership.workspaceId,
    role: membership.role,
    status: membership.status,
    createdAt: membership.createdAt,
    updatedAt: membership.updatedAt
  };
}

function safeSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    userId: session.userId,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    revokedAt: session.revokedAt ?? null
  };
}

function safeApiToken(token) {
  if (!token) return null;
  return {
    id: token.id,
    userId: token.userId,
    name: token.name,
    tokenPrefix: token.tokenPrefix,
    workspaceIds: [...token.workspaceIds],
    scopes: [...token.scopes],
    createdAt: token.createdAt,
    expiresAt: token.expiresAt ?? null,
    revokedAt: token.revokedAt ?? null
  };
}

function safeAuditEvent(event) {
  if (!event) return null;
  return {
    id: event.id,
    type: event.type,
    actorUserId: event.actorUserId ?? null,
    targetUserId: event.targetUserId ?? null,
    workspaceId: event.workspaceId ?? null,
    outcome: event.outcome,
    occurredAt: event.occurredAt,
    correlationId: event.correlationId ?? null,
    metadata: event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata) ? { ...event.metadata } : {}
  };
}

function sanitizeAuditMetadata(metadata = {}) {
  const blocked = /password|secret|token|cookie|credential|hash|salt|csrf/i;
  const out = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (blocked.test(key)) continue;
    if (typeof value === 'string') out[key] = value.slice(0, 240);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
  }
  return out;
}

async function assertSafeDirectory(directory) {
  const resolved = path.resolve(directory);
  const existing = await lstat(resolved).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) throw identityError('unsafe_identity_path', 'identity directory cannot be a symlink');
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  await chmodBestEffort(resolved, 0o700);
  const after = await lstat(resolved);
  if (!after.isDirectory() || after.isSymbolicLink()) throw identityError('unsafe_identity_path', 'identity path must be a directory');
  await stat(resolved, { bigint: false });
  return resolved;
}

async function chmodBestEffort(target, mode) {
  await import('node:fs/promises').then(({ chmod }) => chmod(target, mode)).catch(() => null);
}

function rawToken(prefix) {
  return `${prefix}_${base64url(nodeRandomBytes(TOKEN_SECRET_BYTES))}`;
}

function sessionCookieToken() {
  return rawToken('oaf_ses');
}

function csrfToken() {
  return rawToken('oaf_csrf');
}

function apiTokenValue(id) {
  return `oaf_tok_${id}_${base64url(nodeRandomBytes(TOKEN_SECRET_BYTES))}`;
}

function addDays(iso, days) {
  return new Date(new Date(iso).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function activeAt(record, now) {
  return !record.revokedAt && (!record.expiresAt || record.expiresAt > now);
}

export class LocalIdentityStore {
  constructor({ directory = path.join('.local', 'identity'), clock = nowIso, scrypt = {} } = {}) {
    this.directory = directory;
    this.clock = clock;
    this.scrypt = scryptOptions(scrypt);
    this.file = null;
    this.queue = Promise.resolve();
    this.dummyCredential = null;
  }

  async init() {
    this.directory = await assertSafeDirectory(this.directory);
    this.file = path.join(this.directory, 'identity.json');
    try {
      await this.#read();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.#write(initialState());
    }
    this.dummyCredential = await hashPassword('dummy password for constant path', this.scrypt);
    return this;
  }

  async isBootstrapped() {
    const state = await this.#read();
    return state.memberships.some((membership) => membership.role === 'owner' && membership.status === 'active');
  }

  async bootstrapOwner({ username, displayName, password, workspaceId = 'ws_local', workspaceName = 'Local Workspace' } = {}) {
    assertPasswordPolicy(password);
    const usernameKey = normalizeUsername(username);
    assertDisplayName(displayName);
    assertWorkspaceId(workspaceId);
    return this.#update(async (state) => {
      if (state.memberships.some((membership) => membership.role === 'owner' && membership.status === 'active')) {
        throw identityError('already_bootstrapped', 'identity store is already bootstrapped');
      }
      const at = this.clock();
      const user = {
        id: newId('usr'),
        username,
        usernameKey,
        displayName,
        status: 'active',
        passwordCredential: await hashPassword(password, this.scrypt),
        passwordCredentialVersion: 1,
        createdAt: at,
        updatedAt: at
      };
      const workspace = {
        id: workspaceId,
        name: workspaceName,
        createdAt: at
      };
      const membership = {
        id: newId('wsm'),
        userId: user.id,
        workspaceId,
        role: 'owner',
        status: 'active',
        createdAt: at,
        updatedAt: at
      };
      state.users.push(user);
      state.workspaces.push(workspace);
      state.memberships.push(membership);
      state.auditEvents.push(this.#audit({ type: 'auth.bootstrap_owner', actorUserId: user.id, targetUserId: user.id, workspaceId, outcome: 'allow' }));
      return {
        state,
        result: {
          user: safeUser(user),
          workspace: safeWorkspace(workspace),
          membership: safeMembership(membership)
        }
      };
    });
  }

  async createUser({ username, displayName, password, status = 'active' } = {}) {
    assertPasswordPolicy(password);
    const usernameKey = normalizeUsername(username);
    assertDisplayName(displayName);
    return this.#update(async (state) => {
      if (state.users.some((user) => user.usernameKey === usernameKey)) throw identityError('username_exists', 'username already exists');
      const at = this.clock();
      const user = {
        id: newId('usr'),
        username,
        usernameKey,
        displayName,
        status,
        passwordCredential: await hashPassword(password, this.scrypt),
        passwordCredentialVersion: 1,
        createdAt: at,
        updatedAt: at
      };
      state.users.push(user);
      state.auditEvents.push(this.#audit({ type: 'auth.user_created', targetUserId: user.id, outcome: 'allow' }));
      return { state, result: { user: safeUser(user) } };
    });
  }

  async putWorkspace({ id, name } = {}) {
    assertWorkspaceId(id);
    if (typeof name !== 'string' || name.length < 1 || name.length > 160) throw identityError('invalid_workspace', 'workspace name is invalid');
    return this.#update(async (state) => {
      const existing = state.workspaces.find((workspace) => workspace.id === id);
      if (existing) existing.name = name;
      else state.workspaces.push({ id, name, createdAt: this.clock() });
      return { state, result: safeWorkspace(state.workspaces.find((workspace) => workspace.id === id)) };
    });
  }

  async putMembership({ userId, workspaceId, role, status = 'active' } = {}) {
    assertWorkspaceId(workspaceId);
    if (!ROLE_VALUES.has(role)) throw identityError('invalid_role', 'role is invalid');
    return this.#update(async (state) => {
      if (!state.users.some((user) => user.id === userId)) throw identityError('user_not_found', 'user not found');
      if (!state.workspaces.some((workspace) => workspace.id === workspaceId)) state.workspaces.push({ id: workspaceId, name: workspaceId, createdAt: this.clock() });
      const at = this.clock();
      let membership = state.memberships.find((item) => item.userId === userId && item.workspaceId === workspaceId);
      if (!membership) {
        membership = { id: newId('wsm'), userId, workspaceId, role, status, createdAt: at, updatedAt: at };
        state.memberships.push(membership);
      } else {
        membership.role = role;
        membership.status = status;
        membership.updatedAt = at;
      }
      state.auditEvents.push(this.#audit({ type: 'auth.membership_updated', targetUserId: userId, workspaceId, outcome: 'allow', metadata: { role, status } }));
      return { state, result: safeMembership(membership) };
    });
  }

  async verifyPassword({ username, password } = {}) {
    const usernameKey = typeof username === 'string' ? username.toLowerCase() : '';
    const state = await this.#read();
    const user = state.users.find((item) => item.usernameKey === usernameKey && item.status === 'active');
    let ok = false;
    try {
      ok = await verifyCredential(password, user?.passwordCredential ?? this.dummyCredential);
    } catch {
      ok = false;
    }
    if (!user || !ok) {
      await this.recordAuditEvent({ type: 'auth.login', outcome: 'deny', metadata: { reason: 'invalid_credentials' } });
      return { ok: false, user: null };
    }
    await this.recordAuditEvent({ type: 'auth.login', actorUserId: user.id, targetUserId: user.id, outcome: 'allow' });
    return { ok: true, user: safeUser(user) };
  }

  async createSession({ userId, remoteAddress = null, userAgent = null } = {}) {
    return this.#update(async (state) => {
      const user = state.users.find((item) => item.id === userId && item.status === 'active');
      if (!user) throw identityError('user_not_found', 'user not found');
      const token = sessionCookieToken();
      const csrf = csrfToken();
      const session = {
        id: newId('ses'),
        userId,
        tokenHash: sha256(token),
        csrfHash: sha256(csrf),
        remoteAddressHash: remoteAddress ? sha256(remoteAddress) : null,
        userAgentHash: userAgent ? sha256(userAgent) : null,
        createdAt: this.clock(),
        expiresAt: addDays(this.clock(), 7),
        revokedAt: null
      };
      state.sessions = state.sessions.map((item) => item.userId === userId && !item.revokedAt ? { ...item, revokedAt: this.clock() } : item);
      state.sessions.push(session);
      state.auditEvents.push(this.#audit({ type: 'auth.session_created', actorUserId: userId, targetUserId: userId, outcome: 'allow' }));
      return { state, result: { session: safeSession(session), token, csrfToken: csrf } };
    });
  }

  async authenticateSession({ token, now = this.clock() } = {}) {
    if (typeof token !== 'string' || !token.startsWith('oaf_ses_')) return null;
    const state = await this.#read();
    const tokenHash = sha256(token);
    const session = state.sessions.find((item) => item.tokenHash === tokenHash && activeAt(item, now));
    if (!session) return null;
    const user = state.users.find((item) => item.id === session.userId && item.status === 'active');
    if (!user) return null;
    return {
      session: safeSession(session),
      user: safeUser(user),
      memberships: state.memberships.filter((item) => item.userId === user.id && item.status === 'active').map(safeMembership),
      csrfHash: session.csrfHash
    };
  }

  async revokeSession({ sessionId, actorUserId = null } = {}) {
    return this.#update(async (state) => {
      const session = state.sessions.find((item) => item.id === sessionId);
      if (session && !session.revokedAt) session.revokedAt = this.clock();
      state.auditEvents.push(this.#audit({ type: 'auth.logout', actorUserId, targetUserId: session?.userId ?? null, outcome: session ? 'allow' : 'deny' }));
      return { state, result: { revoked: Boolean(session) } };
    });
  }

  async createApiToken({ actorUserId, name, workspaceIds = [], scopes = [], expiresAt = null } = {}) {
    if (typeof name !== 'string' || name.length < 1 || name.length > 120) throw identityError('invalid_token_name', 'token name is invalid');
    if (!Array.isArray(workspaceIds) || workspaceIds.length < 1 || workspaceIds.length > 16) throw identityError('invalid_workspace', 'workspaceIds are invalid');
    for (const workspaceId of workspaceIds) assertWorkspaceId(workspaceId);
    if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string' || scope.length > 80 || !/^[a-z][a-z0-9.:-]+$/.test(scope))) throw identityError('invalid_token_scope', 'token scopes are invalid');
    return this.#update(async (state) => {
      const user = state.users.find((item) => item.id === actorUserId && item.status === 'active');
      if (!user) throw identityError('user_not_found', 'user not found');
      const id = newId('tok');
      const token = apiTokenValue(id);
      const apiToken = {
        id,
        userId: actorUserId,
        name,
        tokenHash: sha256(token),
        tokenPrefix: token.slice(0, 24),
        workspaceIds: [...new Set(workspaceIds)],
        scopes: [...new Set(scopes)],
        createdAt: this.clock(),
        expiresAt,
        revokedAt: null
      };
      state.apiTokens.push(apiToken);
      state.auditEvents.push(this.#audit({ type: 'auth.token_created', actorUserId, targetUserId: actorUserId, outcome: 'allow', metadata: { tokenId: id, workspaceCount: apiToken.workspaceIds.length, scopeCount: apiToken.scopes.length } }));
      return { state, result: { apiToken: safeApiToken(apiToken), token } };
    });
  }

  async listApiTokens({ userId } = {}) {
    const state = await this.#read();
    return state.apiTokens.filter((item) => item.userId === userId).map(safeApiToken);
  }

  async authenticateApiToken({ token, now = this.clock() } = {}) {
    if (typeof token !== 'string' || !token.startsWith('oaf_tok_')) return null;
    const state = await this.#read();
    const tokenHash = sha256(token);
    const apiToken = state.apiTokens.find((item) => item.tokenHash === tokenHash && activeAt(item, now));
    if (!apiToken) return null;
    const user = state.users.find((item) => item.id === apiToken.userId && item.status === 'active');
    if (!user) return null;
    const memberships = state.memberships.filter((item) => item.userId === user.id && item.status === 'active' && apiToken.workspaceIds.includes(item.workspaceId));
    if (!memberships.length) return null;
    return {
      apiToken: safeApiToken(apiToken),
      user: safeUser(user),
      memberships: memberships.map(safeMembership)
    };
  }

  async revokeApiToken({ tokenId, actorUserId = null } = {}) {
    return this.#update(async (state) => {
      const token = state.apiTokens.find((item) => item.id === tokenId);
      if (token && !token.revokedAt) token.revokedAt = this.clock();
      state.auditEvents.push(this.#audit({ type: 'auth.token_revoked', actorUserId, targetUserId: token?.userId ?? null, outcome: token ? 'allow' : 'deny', metadata: { tokenId } }));
      return { state, result: { revoked: Boolean(token) } };
    });
  }

  async listMemberships({ userId } = {}) {
    const state = await this.#read();
    return state.memberships.filter((item) => item.userId === userId && item.status === 'active').map(safeMembership);
  }

  async recordAuditEvent(event) {
    return this.#update(async (state) => {
      const auditEvent = this.#audit(event);
      state.auditEvents.push(auditEvent);
      return { state, result: safeAuditEvent(auditEvent) };
    });
  }

  async listAuditEvents({ limit = 100 } = {}) {
    const state = await this.#read();
    return state.auditEvents.slice(-Math.max(1, Math.min(500, Number(limit) || 100))).reverse().map(safeAuditEvent);
  }

  async health() {
    return { schemaVersion: '1.0.0', providerId: LOCAL_IDENTITY_PROVIDER_ID, status: 'healthy', local: true, checkedAt: this.clock(), details: { path: this.file } };
  }

  async capabilities() {
    return ['api-token-auth', 'csrf', 'first-owner-bootstrap', 'opaque-session-auth', 'scrypt-passwords', 'security-audit', 'workspace-authorization'];
  }

  #audit({ type, actorUserId = null, targetUserId = null, workspaceId = null, outcome = 'allow', correlationId = null, metadata = {} } = {}) {
    return {
      id: newId('aud'),
      type,
      actorUserId,
      targetUserId,
      workspaceId,
      outcome,
      occurredAt: this.clock(),
      correlationId,
      metadata: sanitizeAuditMetadata(metadata)
    };
  }

  async #read() {
    if (!this.file) throw new Error('LocalIdentityStore.init() must be called before use');
    return JSON.parse(await readFile(this.file, 'utf8'));
  }

  async #write(value) {
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC });
    await chmodBestEffort(tmp, 0o600);
    await rename(tmp, this.file);
    await chmodBestEffort(this.file, 0o600);
  }

  async #update(work) {
    const next = this.queue.then(async () => {
      const state = await this.#read();
      const { state: updated, result } = await work(structuredClone(state));
      await this.#write(updated);
      return result;
    });
    this.queue = next.catch(() => null);
    return next;
  }
}

export function hashOpaqueSecret(value) {
  return sha256(value);
}
