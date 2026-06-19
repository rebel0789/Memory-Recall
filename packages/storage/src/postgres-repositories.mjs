import { assertPlainObject, nowIso } from '../../protocol/src/index.mjs';

const PROVIDER_ID = 'provider:postgres:repositories';

function repositoryError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function assertClient(client) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('PostgreSQL repository client must expose query(text, values)');
  }
  return client;
}

function assertString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  return value;
}

function jsonColumn(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  if (typeof value === 'object' && !Array.isArray(value)) return structuredClone(value);
  if (Array.isArray(value)) return structuredClone(value);
  return fallback;
}

function timestamp(value, fallback = nowIso()) {
  return value ?? fallback;
}

function maybeIso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

async function withTransaction(client, work) {
  const connection = typeof client.connect === 'function' ? await client.connect() : client;
  try {
    await connection.query('BEGIN');
    const result = await work(connection);
    await connection.query('COMMIT');
    return result;
  } catch (error) {
    try { await connection.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    if (connection !== client && typeof connection.release === 'function') connection.release();
  }
}

function mapWorkspace(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    createdAt: maybeIso(row.created_at),
    policy: jsonColumn(row.policy)
  };
}

function mapWorkflowVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workflowKey: row.workflow_key,
    version: row.version,
    definition: jsonColumn(row.definition),
    createdAt: maybeIso(row.created_at)
  };
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workflowVersionId: row.workflow_version_id,
    status: row.status,
    objective: row.objective ?? null,
    createdAt: maybeIso(row.created_at),
    completedAt: maybeIso(row.completed_at) ?? null,
    metadata: jsonColumn(row.metadata)
  };
}

function mapEvent(row) {
  if (!row) return null;
  return {
    schemaVersion: row.schema_version,
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type,
    runId: row.run_id,
    actorId: row.actor_id,
    sequence: Number(row.sequence),
    occurredAt: maybeIso(row.occurred_at),
    correlationId: row.correlation_id,
    causationId: row.causation_id ?? null,
    dataClass: row.data_class,
    producerVersion: row.producer_version,
    payload: jsonColumn(row.payload)
  };
}

function mapContextManifest(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id ?? null,
    compilerVersion: row.compiler_version,
    request: jsonColumn(row.request),
    manifest: jsonColumn(row.manifest),
    createdAt: maybeIso(row.created_at)
  };
}

function mapIdentityUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    usernameKey: row.username_key,
    displayName: row.display_name,
    status: row.status,
    passwordCredential: row.password_credential,
    passwordCredentialVersion: Number(row.password_credential_version),
    createdAt: maybeIso(row.created_at),
    updatedAt: maybeIso(row.updated_at)
  };
}

function mapIdentityMembership(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    role: row.role,
    status: row.status,
    createdAt: maybeIso(row.created_at),
    updatedAt: maybeIso(row.updated_at)
  };
}

function mapIdentitySession(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    csrfHash: row.csrf_hash,
    remoteAddressHash: row.remote_address_hash ?? null,
    userAgentHash: row.user_agent_hash ?? null,
    createdAt: maybeIso(row.created_at),
    expiresAt: maybeIso(row.expires_at),
    revokedAt: maybeIso(row.revoked_at) ?? null
  };
}

function mapIdentityApiToken(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    tokenHash: row.token_hash,
    tokenPrefix: row.token_prefix,
    workspaceIds: row.workspace_ids ?? [],
    scopes: row.scopes ?? [],
    createdAt: maybeIso(row.created_at),
    expiresAt: maybeIso(row.expires_at) ?? null,
    revokedAt: maybeIso(row.revoked_at) ?? null
  };
}

function mapSecurityAuditEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    actorUserId: row.actor_user_id ?? null,
    targetUserId: row.target_user_id ?? null,
    workspaceId: row.workspace_id ?? null,
    outcome: row.outcome,
    occurredAt: maybeIso(row.occurred_at),
    correlationId: row.correlation_id ?? null,
    metadata: jsonColumn(row.metadata)
  };
}

export class PostgresWorkspaceRepository {
  constructor({ client, clock = nowIso } = {}) {
    this.client = assertClient(client);
    this.clock = clock;
  }

  async put(input) {
    assertPlainObject(input, 'workspace');
    const id = assertString(input.id, 'workspace.id');
    const name = assertString(input.name, 'workspace.name');
    const policy = input.policy && typeof input.policy === 'object' && !Array.isArray(input.policy) ? input.policy : {};
    const createdAt = timestamp(input.createdAt, this.clock());
    const result = await this.client.query(
      `
        INSERT INTO workspaces (id, name, policy, created_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          policy = excluded.policy
        RETURNING id, name, created_at, policy
      `,
      [id, name, policy, createdAt]
    );
    return mapWorkspace(result.rows[0]);
  }

  async get({ id }) {
    assertString(id, 'workspace.id');
    const result = await this.client.query(
      'SELECT id, name, created_at, policy FROM workspaces WHERE id = $1',
      [id]
    );
    return mapWorkspace(result.rows[0]);
  }
}

export class PostgresWorkflowVersionRepository {
  constructor({ client, clock = nowIso } = {}) {
    this.client = assertClient(client);
    this.clock = clock;
  }

  async put(input) {
    assertPlainObject(input, 'workflow version');
    const values = [
      assertString(input.id, 'workflowVersion.id'),
      assertString(input.workspaceId, 'workflowVersion.workspaceId'),
      assertString(input.workflowKey, 'workflowVersion.workflowKey'),
      assertString(input.version, 'workflowVersion.version'),
      assertPlainObject(input.definition ?? {}, 'workflowVersion.definition'),
      timestamp(input.createdAt, this.clock())
    ];
    const result = await this.client.query(
      `
        INSERT INTO workflow_versions (id, workspace_id, workflow_key, version, definition, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT(workspace_id, workflow_key, version) DO UPDATE SET
          definition = excluded.definition
        RETURNING id, workspace_id, workflow_key, version, definition, created_at
      `,
      values
    );
    return mapWorkflowVersion(result.rows[0]);
  }

  async get({ workspaceId, id }) {
    assertString(workspaceId, 'workflowVersion.workspaceId');
    assertString(id, 'workflowVersion.id');
    const result = await this.client.query(
      `
        SELECT id, workspace_id, workflow_key, version, definition, created_at
        FROM workflow_versions
        WHERE workspace_id = $1 AND id = $2
      `,
      [workspaceId, id]
    );
    return mapWorkflowVersion(result.rows[0]);
  }
}

export class PostgresRunRepository {
  constructor({ client, clock = nowIso } = {}) {
    this.client = assertClient(client);
    this.clock = clock;
  }

  async put(input) {
    assertPlainObject(input, 'run');
    const values = [
      assertString(input.id, 'run.id'),
      assertString(input.workspaceId, 'run.workspaceId'),
      assertString(input.workflowVersionId, 'run.workflowVersionId'),
      assertString(input.status, 'run.status'),
      input.objective ?? null,
      timestamp(input.createdAt, this.clock()),
      input.completedAt ?? null,
      input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata : {}
    ];
    const result = await this.client.query(
      `
        INSERT INTO runs (id, workspace_id, workflow_version_id, status, objective, created_at, completed_at, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, workspace_id, workflow_version_id, status, objective, created_at, completed_at, metadata
      `,
      values
    );
    return mapRun(result.rows[0]);
  }

  async get({ workspaceId, id }) {
    assertString(workspaceId, 'run.workspaceId');
    assertString(id, 'run.id');
    const result = await this.client.query(
      `
        SELECT id, workspace_id, workflow_version_id, status, objective, created_at, completed_at, metadata
        FROM runs
        WHERE workspace_id = $1 AND id = $2
      `,
      [workspaceId, id]
    );
    return mapRun(result.rows[0]);
  }

  async updateStatus({ workspaceId, id, status, completedAt = null, metadata = null }) {
    assertString(workspaceId, 'run.workspaceId');
    assertString(id, 'run.id');
    assertString(status, 'run.status');
    const result = await this.client.query(
      `
        UPDATE runs
        SET status = $3,
          completed_at = COALESCE($4, completed_at),
          metadata = CASE WHEN $5::jsonb IS NULL THEN metadata ELSE metadata || $5::jsonb END
        WHERE workspace_id = $1 AND id = $2
        RETURNING id, workspace_id, workflow_version_id, status, objective, created_at, completed_at, metadata
      `,
      [workspaceId, id, status, completedAt, metadata]
    );
    return mapRun(result.rows[0]);
  }
}

export class PostgresEventRepository {
  constructor({ client } = {}) {
    this.client = assertClient(client);
  }

  async append(event) {
    assertPlainObject(event, 'event');
    for (const key of ['id', 'workspaceId', 'runId', 'schemaVersion', 'type', 'actorId', 'occurredAt', 'correlationId', 'dataClass', 'producerVersion']) {
      assertString(event[key], `event.${key}`);
    }
    if (!Number.isInteger(event.sequence) || event.sequence < 0) throw new TypeError('event.sequence must be a non-negative integer');
    assertPlainObject(event.payload, 'event.payload');

    return withTransaction(this.client, async (client) => {
      const run = await client.query(
        'SELECT id FROM runs WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
        [event.workspaceId, event.runId]
      );
      if (!run.rows[0]) throw repositoryError('run_not_found', `run not found in workspace: ${event.runId}`, { workspaceId: event.workspaceId, runId: event.runId });

      const sequence = await client.query(
        'SELECT COALESCE(MAX(sequence), -1) AS last_sequence FROM events WHERE workspace_id = $1 AND run_id = $2',
        [event.workspaceId, event.runId]
      );
      const lastSequence = Number(sequence.rows[0]?.last_sequence ?? -1);
      const expected = lastSequence + 1;
      if (event.sequence !== expected) {
        throw repositoryError('event_sequence_conflict', `expected event sequence ${expected}, received ${event.sequence}`, {
          workspaceId: event.workspaceId,
          runId: event.runId,
          expected,
          received: event.sequence
        });
      }

      const result = await client.query(
        `
          INSERT INTO events (
            id, workspace_id, run_id, sequence, schema_version, type, actor_id,
            occurred_at, correlation_id, causation_id, data_class, producer_version, payload
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          RETURNING id, workspace_id, run_id, sequence, schema_version, type, actor_id,
            occurred_at, correlation_id, causation_id, data_class, producer_version, payload
        `,
        [
          event.id,
          event.workspaceId,
          event.runId,
          event.sequence,
          event.schemaVersion,
          event.type,
          event.actorId,
          event.occurredAt,
          event.correlationId,
          event.causationId ?? null,
          event.dataClass,
          event.producerVersion,
          event.payload
        ]
      );
      return mapEvent(result.rows[0]);
    });
  }

  async listByRun({ workspaceId, runId, limit = 1000 }) {
    assertString(workspaceId, 'event.workspaceId');
    assertString(runId, 'event.runId');
    const boundedLimit = Math.max(1, Math.min(5000, Number(limit) || 1000));
    const result = await this.client.query(
      `
        SELECT id, workspace_id, run_id, sequence, schema_version, type, actor_id,
          occurred_at, correlation_id, causation_id, data_class, producer_version, payload
        FROM events
        WHERE workspace_id = $1 AND run_id = $2
        ORDER BY sequence ASC
        LIMIT $3
      `,
      [workspaceId, runId, boundedLimit]
    );
    return result.rows.map(mapEvent);
  }
}

export class PostgresContextManifestRepository {
  constructor({ client, clock = nowIso } = {}) {
    this.client = assertClient(client);
    this.clock = clock;
  }

  async put(input) {
    assertPlainObject(input, 'context manifest');
    const values = [
      assertString(input.id, 'contextManifest.id'),
      assertString(input.workspaceId, 'contextManifest.workspaceId'),
      input.runId ?? null,
      assertString(input.compilerVersion, 'contextManifest.compilerVersion'),
      assertPlainObject(input.request, 'contextManifest.request'),
      assertPlainObject(input.manifest, 'contextManifest.manifest'),
      timestamp(input.createdAt, this.clock())
    ];
    const result = await this.client.query(
      `
        INSERT INTO context_manifests (id, workspace_id, run_id, compiler_version, request, manifest, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, workspace_id, run_id, compiler_version, request, manifest, created_at
      `,
      values
    );
    return mapContextManifest(result.rows[0]);
  }

  async listByRun({ workspaceId, runId, limit = 100 }) {
    assertString(workspaceId, 'contextManifest.workspaceId');
    assertString(runId, 'contextManifest.runId');
    const boundedLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    const result = await this.client.query(
      `
        SELECT id, workspace_id, run_id, compiler_version, request, manifest, created_at
        FROM context_manifests
        WHERE workspace_id = $1 AND run_id = $2
        ORDER BY created_at DESC, id ASC
        LIMIT $3
      `,
      [workspaceId, runId, boundedLimit]
    );
    return result.rows.map(mapContextManifest);
  }
}

export class PostgresIdentityRepository {
  constructor({ client, clock = nowIso } = {}) {
    this.client = assertClient(client);
    this.clock = clock;
  }

  async putUser(input) {
    assertPlainObject(input, 'identity user');
    const values = [
      assertString(input.id, 'identityUser.id'),
      assertString(input.username, 'identityUser.username'),
      assertString(input.usernameKey, 'identityUser.usernameKey'),
      assertString(input.displayName, 'identityUser.displayName'),
      assertString(input.status, 'identityUser.status'),
      assertString(input.passwordCredential, 'identityUser.passwordCredential'),
      Number(input.passwordCredentialVersion ?? 1),
      timestamp(input.createdAt, this.clock()),
      timestamp(input.updatedAt, this.clock())
    ];
    const result = await this.client.query(
      `
        INSERT INTO identity_users (
          id, username, username_key, display_name, status,
          password_credential, password_credential_version, created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(id) DO UPDATE SET
          username = excluded.username,
          username_key = excluded.username_key,
          display_name = excluded.display_name,
          status = excluded.status,
          password_credential = excluded.password_credential,
          password_credential_version = excluded.password_credential_version,
          updated_at = excluded.updated_at
        RETURNING *
      `,
      values
    );
    return mapIdentityUser(result.rows[0]);
  }

  async getUserByUsernameKey({ usernameKey }) {
    assertString(usernameKey, 'identityUser.usernameKey');
    const result = await this.client.query('SELECT * FROM identity_users WHERE username_key = $1', [usernameKey]);
    return mapIdentityUser(result.rows[0]);
  }

  async putMembership(input) {
    assertPlainObject(input, 'workspace membership');
    const values = [
      assertString(input.id, 'membership.id'),
      assertString(input.userId, 'membership.userId'),
      assertString(input.workspaceId, 'membership.workspaceId'),
      assertString(input.role, 'membership.role'),
      assertString(input.status, 'membership.status'),
      timestamp(input.createdAt, this.clock()),
      timestamp(input.updatedAt, this.clock())
    ];
    const result = await this.client.query(
      `
        INSERT INTO identity_workspace_memberships (id, user_id, workspace_id, role, status, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(user_id, workspace_id) DO UPDATE SET
          role = excluded.role,
          status = excluded.status,
          updated_at = excluded.updated_at
        RETURNING *
      `,
      values
    );
    return mapIdentityMembership(result.rows[0]);
  }

  async listMembershipsByUser({ userId }) {
    assertString(userId, 'membership.userId');
    const result = await this.client.query('SELECT * FROM identity_workspace_memberships WHERE user_id = $1 ORDER BY workspace_id ASC', [userId]);
    return result.rows.map(mapIdentityMembership);
  }

  async putSession(input) {
    assertPlainObject(input, 'identity session');
    const values = [
      assertString(input.id, 'session.id'),
      assertString(input.userId, 'session.userId'),
      assertString(input.tokenHash, 'session.tokenHash'),
      assertString(input.csrfHash, 'session.csrfHash'),
      input.remoteAddressHash ?? null,
      input.userAgentHash ?? null,
      timestamp(input.createdAt, this.clock()),
      assertString(input.expiresAt, 'session.expiresAt'),
      input.revokedAt ?? null
    ];
    const result = await this.client.query(
      `
        INSERT INTO identity_sessions (
          id, user_id, token_hash, csrf_hash, remote_address_hash,
          user_agent_hash, created_at, expires_at, revoked_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING *
      `,
      values
    );
    return mapIdentitySession(result.rows[0]);
  }

  async getSessionByTokenHash({ tokenHash }) {
    assertString(tokenHash, 'session.tokenHash');
    const result = await this.client.query('SELECT * FROM identity_sessions WHERE token_hash = $1', [tokenHash]);
    return mapIdentitySession(result.rows[0]);
  }

  async revokeSession({ id, revokedAt = this.clock() }) {
    assertString(id, 'session.id');
    const result = await this.client.query('UPDATE identity_sessions SET revoked_at = $2 WHERE id = $1 RETURNING *', [id, revokedAt]);
    return mapIdentitySession(result.rows[0]);
  }

  async putApiToken(input) {
    assertPlainObject(input, 'api token');
    const values = [
      assertString(input.id, 'apiToken.id'),
      assertString(input.userId, 'apiToken.userId'),
      assertString(input.name, 'apiToken.name'),
      assertString(input.tokenHash, 'apiToken.tokenHash'),
      assertString(input.tokenPrefix, 'apiToken.tokenPrefix'),
      Array.isArray(input.workspaceIds) ? input.workspaceIds : [],
      Array.isArray(input.scopes) ? input.scopes : [],
      timestamp(input.createdAt, this.clock()),
      input.expiresAt ?? null,
      input.revokedAt ?? null
    ];
    const result = await this.client.query(
      `
        INSERT INTO identity_api_tokens (
          id, user_id, name, token_hash, token_prefix,
          workspace_ids, scopes, created_at, expires_at, revoked_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING *
      `,
      values
    );
    return mapIdentityApiToken(result.rows[0]);
  }

  async getApiTokenByTokenHash({ tokenHash }) {
    assertString(tokenHash, 'apiToken.tokenHash');
    const result = await this.client.query('SELECT * FROM identity_api_tokens WHERE token_hash = $1', [tokenHash]);
    return mapIdentityApiToken(result.rows[0]);
  }

  async listApiTokensByUser({ userId }) {
    assertString(userId, 'apiToken.userId');
    const result = await this.client.query('SELECT * FROM identity_api_tokens WHERE user_id = $1 ORDER BY created_at DESC, id ASC', [userId]);
    return result.rows.map(mapIdentityApiToken);
  }

  async revokeApiToken({ id, revokedAt = this.clock() }) {
    assertString(id, 'apiToken.id');
    const result = await this.client.query('UPDATE identity_api_tokens SET revoked_at = $2 WHERE id = $1 RETURNING *', [id, revokedAt]);
    return mapIdentityApiToken(result.rows[0]);
  }

  async appendAuditEvent(input) {
    assertPlainObject(input, 'security audit event');
    const values = [
      assertString(input.id, 'auditEvent.id'),
      assertString(input.type, 'auditEvent.type'),
      input.actorUserId ?? null,
      input.targetUserId ?? null,
      input.workspaceId ?? null,
      assertString(input.outcome, 'auditEvent.outcome'),
      timestamp(input.occurredAt, this.clock()),
      input.correlationId ?? null,
      input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata : {}
    ];
    const result = await this.client.query(
      `
        INSERT INTO security_audit_events (
          id, type, actor_user_id, target_user_id, workspace_id,
          outcome, occurred_at, correlation_id, metadata
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING *
      `,
      values
    );
    return mapSecurityAuditEvent(result.rows[0]);
  }
}

export function createPostgresRepositories({ client, clock = nowIso } = {}) {
  assertClient(client);
  return {
    providerId: PROVIDER_ID,
    workspaces: new PostgresWorkspaceRepository({ client, clock }),
    workflowVersions: new PostgresWorkflowVersionRepository({ client, clock }),
    runs: new PostgresRunRepository({ client, clock }),
    events: new PostgresEventRepository({ client }),
    contextManifests: new PostgresContextManifestRepository({ client, clock }),
    identity: new PostgresIdentityRepository({ client, clock })
  };
}

export { PROVIDER_ID as POSTGRES_REPOSITORY_PROVIDER_ID };
