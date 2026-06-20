import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createEvent, nowIso, prefixedId } from '../../../../packages/protocol/src/index.mjs';

export const DURABLE_SQLITE_WORKFLOW_PROVIDER_ID = 'provider:native:workflow:durable-sqlite';
const SCHEMA_VERSION = 1;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const RUNNABLE = new Set(['queued', 'running', 'waiting_retry', 'waiting_timer']);
const STEP_KINDS = new Set(['deterministic', 'model', 'activity', 'timer', 'approval']);
const DEFAULT_LIMITS = Object.freeze({
  workflowDefinitionBytes: 128 * 1024,
  workflowInputBytes: 64 * 1024,
  stepOutputBytes: 64 * 1024,
  errorPayloadBytes: 4096,
  eventPayloadBytes: 8192,
  historyEventCount: 5000,
  runListPageSize: 100,
  maxSteps: 64,
  maxAttempts: 5,
  timerHorizonMs: 24 * 60 * 60 * 1000,
  approvalWaitMs: 24 * 60 * 60 * 1000
});

function workflowError(code, message, details = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.details = details;
  return error;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
}

function assertString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw workflowError('invalid_workflow_input', `${name} is required`);
  return value;
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function boundedJson(value, name, limit) {
  const bytes = jsonBytes(value);
  if (bytes > limit) throw workflowError('workflow_payload_too_large', `${name} exceeds ${limit} bytes`, { bytes, limit });
  return JSON.stringify(value);
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  return JSON.parse(value);
}

function addMs(iso, ms) {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function isDue(iso, now) {
  return !iso || Date.parse(iso) <= Date.parse(now);
}

function sanitizeReason(reason) {
  return String(reason ?? 'cancelled').replace(/[^\w .:-]/gu, '').slice(0, 240) || 'cancelled';
}

function normalizeDefinition(input, limits) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw workflowError('workflow_definition_invalid', 'workflow definition must be an object');
  const serialized = JSON.stringify(input, (_key, value) => {
    if (typeof value === 'function') throw workflowError('workflow_definition_not_serializable', 'workflow definitions must not contain functions');
    return value;
  });
  if (Buffer.byteLength(serialized, 'utf8') > limits.workflowDefinitionBytes) {
    throw workflowError('workflow_definition_too_large', 'workflow definition exceeds configured bound');
  }
  const definition = structuredClone(input);
  for (const key of ['schemaVersion', 'id', 'version', 'name', 'description', 'steps']) {
    if (definition[key] === undefined) throw workflowError('workflow_definition_invalid', `workflow definition missing ${key}`);
  }
  if (definition.schemaVersion !== '1.0.0') throw workflowError('workflow_definition_invalid', 'unsupported workflow schema version');
  if (!Array.isArray(definition.steps) || !definition.steps.length || definition.steps.length > limits.maxSteps) {
    throw workflowError('workflow_definition_invalid', 'workflow definition must have a bounded non-empty steps array');
  }
  const seen = new Set();
  for (const step of definition.steps) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw workflowError('workflow_definition_invalid', 'workflow step must be an object');
    assertString(step.id, 'step.id');
    if (seen.has(step.id)) throw workflowError('workflow_definition_invalid', `duplicate step id: ${step.id}`);
    seen.add(step.id);
    if (!STEP_KINDS.has(step.kind)) throw workflowError('workflow_definition_invalid', `unsupported step kind: ${step.kind}`);
    if (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 1) throw workflowError('workflow_definition_invalid', `step ${step.id} requires positive timeoutMs`);
    const maxAttempts = step.retry?.maxAttempts ?? 1;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > limits.maxAttempts) {
      throw workflowError('workflow_definition_invalid', `step ${step.id} maxAttempts is out of bounds`);
    }
    if (!['read-only', 'reversible-write', 'consequential-write'].includes(step.riskClass)) {
      throw workflowError('workflow_definition_invalid', `step ${step.id} has invalid riskClass`);
    }
    if (!['timer', 'approval'].includes(step.kind)) {
      if (!step.handler?.id || !step.handler?.version) throw workflowError('workflow_definition_invalid', `step ${step.id} requires handler reference`);
    }
  }
  const fingerprint = sha256(definition);
  return { ...definition, fingerprint };
}

function mapRun(row, steps = []) {
  if (!row) return null;
  const stepMap = {};
  for (const step of steps) {
    stepMap[step.step_id] = {
      stepId: step.step_id,
      kind: step.kind,
      status: step.status,
      attempt: Number(step.attempt),
      handler: step.handler_id ? { id: step.handler_id, version: step.handler_version } : null,
      output: parseJson(step.output_json, null),
      error: parseJson(step.error_json, null),
      nextAt: step.next_at,
      approvalId: step.approval_id,
      idempotencyKey: step.idempotency_key,
      operationFingerprint: step.operation_fingerprint
    };
  }
  return {
    schemaVersion: '1.0.0',
    provider: DURABLE_SQLITE_WORKFLOW_PROVIDER_ID,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    workflowId: row.workflow_id,
    workflowVersion: row.workflow_version,
    workflowFingerprint: row.workflow_fingerprint,
    status: row.status,
    currentStep: Number(row.current_step),
    input: parseJson(row.input_json, {}),
    output: parseJson(row.output_json, null),
    error: parseJson(row.error_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    steps: stepMap
  };
}

function mapEvent(row) {
  return {
    schemaVersion: row.schema_version,
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type,
    runId: row.run_id,
    actorId: row.actor_id,
    sequence: Number(row.sequence),
    occurredAt: row.occurred_at,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    dataClass: row.data_class,
    producerVersion: row.producer_version,
    payload: parseJson(row.payload_json, {})
  };
}

function timeoutPromise(ms, controller) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = workflowError('step_timeout', `step timed out after ${ms}ms`);
      error.retryable = true;
      controller.abort(error);
      reject(error);
    }, ms);
  });
  return { promise, clear: () => clearTimeout(timer) };
}

export class DurableWorkflowHandlerRegistry {
  constructor() {
    this.handlers = new Map();
  }

  register({ id, version, capabilities = [], run }) {
    assertString(id, 'handler.id');
    assertString(version, 'handler.version');
    if (typeof run !== 'function') throw workflowError('handler_invalid', 'handler run implementation is required');
    const key = `${id}@${version}`;
    if (this.handlers.has(key)) throw workflowError('handler_duplicate', `duplicate handler: ${key}`);
    this.handlers.set(key, Object.freeze({ id, version, capabilities: Object.freeze([...capabilities]), run }));
    return this;
  }

  get({ id, version }) {
    const handler = this.handlers.get(`${id}@${version}`);
    if (!handler) throw workflowError('handler_not_found', `handler not registered: ${id}@${version}`);
    return handler;
  }

  has(ref) {
    return this.handlers.has(`${ref?.id}@${ref?.version}`);
  }
}

export class DurableSQLiteWorkflowRuntime {
  constructor({
    dataRoot = '.local',
    filename = null,
    registry = new DurableWorkflowHandlerRegistry(),
    clock = nowIso,
    eventIdFactory = () => prefixedId('evt'),
    leaseMs = 5000,
    limits = {}
  } = {}) {
    this.dataRoot = path.resolve(dataRoot);
    this.filename = path.resolve(filename ?? path.join(this.dataRoot, 'workflows.sqlite'));
    if (!this.filename.startsWith(`${this.dataRoot}${path.sep}`) && this.filename !== path.join(this.dataRoot, 'workflows.sqlite')) {
      throw workflowError('workflow_path_escape', 'workflow database path must stay under data root');
    }
    this.registry = registry;
    this.clock = clock;
    this.eventIdFactory = eventIdFactory;
    this.leaseMs = Math.max(10, Number(leaseMs) || 5000);
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.active = new Map();
    mkdirSync(this.dataRoot, { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(this.filename);
    this.#migrate();
  }

  #migrate() {
    this.database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runtime_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO runtime_metadata(key, value) VALUES ('schema_version', '${SCHEMA_VERSION}');
      CREATE TABLE IF NOT EXISTS workflow_definitions (
        workflow_id TEXT NOT NULL,
        version TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workflow_id, version)
      );
      CREATE TABLE IF NOT EXISTS runs (
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        workflow_version TEXT NOT NULL,
        workflow_fingerprint TEXT NOT NULL,
        input_json TEXT NOT NULL,
        input_fingerprint TEXT NOT NULL,
        start_key TEXT NOT NULL,
        start_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        current_step INTEGER NOT NULL,
        output_json TEXT,
        error_json TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        resume_recorded INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (workspace_id, run_id),
        UNIQUE (workspace_id, start_key)
      );
      CREATE TABLE IF NOT EXISTS steps (
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        handler_id TEXT,
        handler_version TEXT,
        output_json TEXT,
        error_json TEXT,
        next_at TEXT,
        approval_id TEXT,
        idempotency_key TEXT,
        operation_fingerprint TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, run_id, step_id),
        FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, run_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS approvals (
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        approval_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        operation_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_at TEXT,
        actor_id TEXT,
        decision TEXT,
        PRIMARY KEY (workspace_id, run_id, approval_id)
      );
      CREATE TABLE IF NOT EXISTS effects (
        workspace_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        operation_fingerprint TEXT NOT NULL,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        output_json TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS events (
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        id TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        causation_id TEXT,
        data_class TEXT NOT NULL,
        producer_version TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (workspace_id, run_id, sequence),
        UNIQUE (id)
      );
      CREATE INDEX IF NOT EXISTS idx_runs_workspace_status ON runs(workspace_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_steps_runnable ON steps(workspace_id, run_id, status, next_at);
    `);
  }

  #transaction(work) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  #definition(workflowId, workflowVersion) {
    const row = this.database.prepare('SELECT * FROM workflow_definitions WHERE workflow_id = ? AND version = ?').get(workflowId, workflowVersion);
    if (!row) throw workflowError('workflow_definition_not_found', `workflow not registered: ${workflowId}@${workflowVersion}`);
    return { fingerprint: row.fingerprint, definition: parseJson(row.definition_json, {}) };
  }

  #run(workspaceId, runId) {
    return this.database.prepare('SELECT * FROM runs WHERE workspace_id = ? AND run_id = ?').get(workspaceId, runId);
  }

  #steps(workspaceId, runId) {
    return this.database.prepare('SELECT * FROM steps WHERE workspace_id = ? AND run_id = ? ORDER BY step_index ASC').all(workspaceId, runId);
  }

  #appendEvent({ workspaceId, runId, type, payload = {}, actorId = 'system', causationId = null }) {
    const sequence = Number(this.database.prepare('SELECT COALESCE(MAX(sequence), -1) AS last FROM events WHERE workspace_id = ? AND run_id = ?').get(workspaceId, runId).last) + 1;
    const event = {
      ...createEvent({ workspaceId, runId, type, actorId, payload, sequence, causationId }),
      id: this.eventIdFactory(),
      occurredAt: this.clock()
    };
    const payloadJson = boundedJson(event.payload, 'event payload', this.limits.eventPayloadBytes);
    this.database.prepare(`
      INSERT INTO events (
        workspace_id, run_id, sequence, id, schema_version, type, actor_id,
        occurred_at, correlation_id, causation_id, data_class, producer_version, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.workspaceId,
      event.runId,
      event.sequence,
      event.id,
      event.schemaVersion,
      event.type,
      event.actorId,
      event.occurredAt,
      event.correlationId,
      event.causationId,
      event.dataClass,
      event.producerVersion,
      payloadJson
    );
    return event;
  }

  async health() {
    const integrity = this.database.prepare('PRAGMA integrity_check').get().integrity_check;
    const schema = this.database.prepare("SELECT value FROM runtime_metadata WHERE key = 'schema_version'").get()?.value;
    return {
      status: integrity === 'ok' && Number(schema) === SCHEMA_VERSION ? 'healthy' : 'degraded',
      local: true,
      details: {
        provider: DURABLE_SQLITE_WORKFLOW_PROVIDER_ID,
        storage: 'sqlite-file',
        integrity,
        schemaVersion: Number(schema),
        processRecovery: true,
        externalWrites: false,
        network: false
      }
    };
  }

  async capabilities() {
    return [
      'workflow.start',
      'workflow.inspect',
      'workflow.list',
      'workflow.cancel',
      'workflow.signal',
      'workflow.history',
      'workflow.process-recovery',
      'workflow.durable-timer',
      'workflow.durable-retry',
      'workflow.approval-wait',
      'workflow.idempotency',
      'workflow.worker-lease'
    ];
  }

  async registerWorkflow(input) {
    const definition = normalizeDefinition(input, this.limits);
    for (const step of definition.steps) {
      if (step.handler && !this.registry.has(step.handler)) {
        throw workflowError('handler_not_found', `handler not registered: ${step.handler.id}@${step.handler.version}`);
      }
    }
    const existing = this.database.prepare('SELECT fingerprint FROM workflow_definitions WHERE workflow_id = ? AND version = ?').get(definition.id, definition.version);
    if (existing) {
      if (existing.fingerprint !== definition.fingerprint) {
        throw workflowError('workflow_version_fingerprint_conflict', 'same workflow ID/version has a different fingerprint');
      }
      return { workflowId: definition.id, version: definition.version, fingerprint: definition.fingerprint, idempotent: true };
    }
    this.database.prepare('INSERT INTO workflow_definitions(workflow_id, version, fingerprint, definition_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(definition.id, definition.version, definition.fingerprint, boundedJson(definition, 'workflow definition', this.limits.workflowDefinitionBytes), this.clock());
    return { workflowId: definition.id, version: definition.version, fingerprint: definition.fingerprint, idempotent: false };
  }

  async start({ workspaceId = 'ws_local', workflowId, workflowVersion, runId = prefixedId('run'), input = {}, idempotencyKey = null, overrideHandlerId = null } = {}) {
    assertString(workspaceId, 'workspaceId');
    assertString(workflowId, 'workflowId');
    assertString(workflowVersion, 'workflowVersion');
    assertString(runId, 'runId');
    const { definition, fingerprint } = this.#definition(workflowId, workflowVersion);
    if (overrideHandlerId) this.registry.get({ id: overrideHandlerId, version: '1.0.0' });
    const inputJson = boundedJson(input, 'workflow input', this.limits.workflowInputBytes);
    const startKey = idempotencyKey ?? `start:${runId}`;
    const startFingerprint = sha256({ workflowId, workflowVersion, fingerprint, input });
    const existing = this.#run(workspaceId, runId) ?? this.database.prepare('SELECT * FROM runs WHERE workspace_id = ? AND start_key = ?').get(workspaceId, startKey);
    if (existing) {
      if (existing.start_fingerprint !== startFingerprint) throw workflowError('start_idempotency_conflict', 'same start idempotency key has different input or workflow fingerprint');
      return mapRun(existing, this.#steps(existing.workspace_id, existing.run_id));
    }
    const now = this.clock();
    this.#transaction(() => {
      this.database.prepare(`
        INSERT INTO runs (
          workspace_id, run_id, workflow_id, workflow_version, workflow_fingerprint,
          input_json, input_fingerprint, start_key, start_fingerprint, status,
          current_step, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)
      `).run(workspaceId, runId, workflowId, workflowVersion, fingerprint, inputJson, sha256(input), startKey, startFingerprint, now, now);
      definition.steps.forEach((step, index) => {
        this.database.prepare(`
          INSERT INTO steps (
            workspace_id, run_id, step_id, step_index, kind, status, attempt,
            handler_id, handler_version, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
        `).run(workspaceId, runId, step.id, index, step.kind, step.handler?.id ?? null, step.handler?.version ?? null, now);
      });
      this.#appendEvent({ workspaceId, runId, type: 'run.created', payload: { workflowId, workflowVersion, workflowFingerprint: fingerprint, stepCount: definition.steps.length } });
    });
    return this.get({ workspaceId, runId });
  }

  async get({ workspaceId = 'ws_local', runId }) {
    assertString(workspaceId, 'workspaceId');
    assertString(runId, 'runId');
    const run = this.#run(workspaceId, runId);
    if (!run) return null;
    return mapRun(run, this.#steps(workspaceId, runId));
  }

  async list({ workspaceId = 'ws_local', limit = 50 } = {}) {
    const boundedLimit = Math.max(1, Math.min(this.limits.runListPageSize, Number(limit) || 50));
    const rows = this.database.prepare('SELECT * FROM runs WHERE workspace_id = ? ORDER BY updated_at DESC, run_id ASC LIMIT ?').all(workspaceId, boundedLimit);
    return { schemaVersion: '1.0.0', provider: DURABLE_SQLITE_WORKFLOW_PROVIDER_ID, items: rows.map((row) => mapRun(row, this.#steps(row.workspace_id, row.run_id))) };
  }

  async history({ workspaceId = 'ws_local', runId, limit = this.limits.historyEventCount }) {
    const boundedLimit = Math.max(1, Math.min(this.limits.historyEventCount, Number(limit) || this.limits.historyEventCount));
    const rows = this.database.prepare('SELECT * FROM events WHERE workspace_id = ? AND run_id = ? ORDER BY sequence ASC LIMIT ?').all(workspaceId, runId, boundedLimit);
    return { schemaVersion: '1.0.0', workspaceId, runId, events: rows.map(mapEvent) };
  }

  async cancel({ workspaceId = 'ws_local', runId, reason = 'cancelled by operator' }) {
    const run = this.#run(workspaceId, runId);
    if (!run) return { cancelled: false, reason: 'run not found' };
    if (TERMINAL.has(run.status)) return { cancelled: false, reason: `run is ${run.status}` };
    const controller = this.active.get(`${workspaceId}:${runId}`);
    if (controller) controller.abort(workflowError('run_cancelled', sanitizeReason(reason)));
    const now = this.clock();
    this.#transaction(() => {
      const current = this.#run(workspaceId, runId);
      if (!current || TERMINAL.has(current.status)) return;
      this.database.prepare('UPDATE runs SET status = ?, error_json = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ? WHERE workspace_id = ? AND run_id = ?')
        .run('cancelled', boundedJson({ code: 'run_cancelled', message: sanitizeReason(reason) }, 'error payload', this.limits.errorPayloadBytes), now, now, workspaceId, runId);
      this.database.prepare("UPDATE steps SET status = CASE WHEN status IN ('completed') THEN status ELSE 'cancelled' END, updated_at = ? WHERE workspace_id = ? AND run_id = ?").run(now, workspaceId, runId);
      this.#appendEvent({ workspaceId, runId, type: 'run.cancelled', payload: { code: 'run_cancelled', reason: sanitizeReason(reason) } });
    });
    return { cancelled: true, reason: sanitizeReason(reason) };
  }

  async signal(input) {
    return this.resolveApproval(input);
  }

  async resolveApproval({ workspaceId = 'ws_local', runId, approvalId, actorId, decision, operationFingerprint }) {
    for (const [value, name] of [[runId, 'runId'], [approvalId, 'approvalId'], [actorId, 'actorId'], [decision, 'decision'], [operationFingerprint, 'operationFingerprint']]) assertString(value, name);
    if (!['approved', 'rejected'].includes(decision)) throw workflowError('approval_decision_invalid', 'decision must be approved or rejected');
    const now = this.clock();
    return this.#transaction(() => {
      const approval = this.database.prepare('SELECT * FROM approvals WHERE workspace_id = ? AND run_id = ? AND approval_id = ?').get(workspaceId, runId, approvalId);
      if (!approval) throw workflowError('approval_not_found', 'approval not found');
      if (approval.operation_fingerprint !== operationFingerprint) throw workflowError('approval_fingerprint_mismatch', 'approval operation fingerprint mismatch');
      if (approval.state !== 'pending') return { resolved: false, state: approval.state };
      if (Date.parse(approval.expires_at) <= Date.parse(now)) {
        this.database.prepare("UPDATE approvals SET state = 'expired', resolved_at = ? WHERE workspace_id = ? AND run_id = ? AND approval_id = ?").run(now, workspaceId, runId, approvalId);
        this.database.prepare("UPDATE runs SET status = 'failed', error_json = ?, completed_at = ?, updated_at = ? WHERE workspace_id = ? AND run_id = ?")
          .run(boundedJson({ code: 'approval_expired', approvalId }, 'error payload', this.limits.errorPayloadBytes), now, now, workspaceId, runId);
        this.#appendEvent({ workspaceId, runId, type: 'approval.expired', actorId, payload: { approvalId, stepId: approval.step_id } });
        this.#appendEvent({ workspaceId, runId, type: 'run.failed', payload: { code: 'approval_expired' } });
        return { resolved: false, state: 'expired' };
      }
      this.database.prepare('UPDATE approvals SET state = ?, resolved_at = ?, actor_id = ?, decision = ? WHERE workspace_id = ? AND run_id = ? AND approval_id = ?')
        .run(decision, now, actorId, decision, workspaceId, runId, approvalId);
      if (decision === 'approved') {
        this.database.prepare("UPDATE steps SET status = 'approval_resolved', updated_at = ? WHERE workspace_id = ? AND run_id = ? AND step_id = ?").run(now, workspaceId, runId, approval.step_id);
        this.database.prepare("UPDATE runs SET status = 'running', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE workspace_id = ? AND run_id = ?").run(now, workspaceId, runId);
      } else {
        this.database.prepare("UPDATE steps SET status = 'failed', error_json = ?, updated_at = ? WHERE workspace_id = ? AND run_id = ? AND step_id = ?")
          .run(boundedJson({ code: 'approval_rejected', approvalId }, 'error payload', this.limits.errorPayloadBytes), now, workspaceId, runId, approval.step_id);
        this.database.prepare("UPDATE runs SET status = 'failed', error_json = ?, completed_at = ?, updated_at = ? WHERE workspace_id = ? AND run_id = ?")
          .run(boundedJson({ code: 'approval_rejected', approvalId }, 'error payload', this.limits.errorPayloadBytes), now, now, workspaceId, runId);
        this.#appendEvent({ workspaceId, runId, type: 'run.failed', payload: { code: 'approval_rejected' } });
      }
      this.#appendEvent({ workspaceId, runId, type: 'approval.resolved', actorId, payload: { approvalId, stepId: approval.step_id, decision } });
      return { resolved: true, decision };
    });
  }

  #claim(workerId) {
    const now = this.clock();
    const rows = this.database.prepare(`
      SELECT * FROM runs
      WHERE status IN ('queued','running','waiting_retry','waiting_timer')
      ORDER BY updated_at ASC, run_id ASC
    `).all();
    for (const row of rows) {
      if (row.lease_owner && row.lease_expires_at && Date.parse(row.lease_expires_at) > Date.parse(now)) continue;
      const runnableStep = this.#nextRunnableStep(row);
      if (!runnableStep) continue;
      const changed = this.database.prepare(`
        UPDATE runs
        SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
        WHERE workspace_id = ? AND run_id = ?
          AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
          AND status NOT IN ('completed','failed','cancelled')
      `).run(workerId, addMs(now, this.leaseMs), now, row.workspace_id, row.run_id, now).changes;
      if (changed === 1) return this.#run(row.workspace_id, row.run_id);
    }
    return null;
  }

  #nextRunnableStep(run) {
    const steps = this.#steps(run.workspace_id, run.run_id);
    const step = steps.find((candidate) => !['completed', 'cancelled', 'failed'].includes(candidate.status));
    if (!step) return null;
    const now = this.clock();
    if (step.status === 'waiting_retry' && !isDue(step.next_at, now)) return null;
    if (step.status === 'waiting_timer' && !isDue(step.next_at, now)) return null;
    if (step.status === 'waiting_approval') return null;
    return step;
  }

  async tick({ workerId = `worker_${randomUUID().slice(0, 8)}` } = {}) {
    assertString(workerId, 'workerId');
    const run = this.#claim(workerId);
    if (!run) return { claimed: false, reason: 'no_runnable_runs' };
    try {
      await this.#workClaim(run, workerId);
      return { claimed: true, runId: run.run_id, workspaceId: run.workspace_id };
    } catch (error) {
      if (error.code === 'run_cancelled') return { claimed: true, runId: run.run_id, workspaceId: run.workspace_id, cancelled: true };
      throw error;
    }
  }

  async #workClaim(claimedRun, workerId) {
    const workspaceId = claimedRun.workspace_id;
    const runId = claimedRun.run_id;
    const { definition } = this.#definition(claimedRun.workflow_id, claimedRun.workflow_version);
    const current = this.#run(workspaceId, runId);
    if (!current || TERMINAL.has(current.status) || current.lease_owner !== workerId) return;
    if (current.workflow_fingerprint !== this.#definition(current.workflow_id, current.workflow_version).fingerprint) {
      throw workflowError('workflow_version_fingerprint_conflict', 'registered workflow fingerprint differs from persisted run');
    }
    const stepRow = this.#nextRunnableStep(current);
    if (!stepRow) {
      this.#release(workspaceId, runId, workerId);
      return;
    }
    const stepDef = definition.steps.find((step) => step.id === stepRow.step_id);
    if (!stepDef) throw workflowError('workflow_definition_invalid', `missing step definition: ${stepRow.step_id}`);
    if (current.status === 'queued') {
      this.#transaction(() => {
        this.database.prepare("UPDATE runs SET status = 'running', updated_at = ? WHERE workspace_id = ? AND run_id = ?").run(this.clock(), workspaceId, runId);
        this.#appendEvent({ workspaceId, runId, type: 'run.started', payload: { workflowId: current.workflow_id, workflowVersion: current.workflow_version } });
      });
    } else if (!current.resume_recorded) {
      this.#transaction(() => {
        this.database.prepare('UPDATE runs SET resume_recorded = 1, updated_at = ? WHERE workspace_id = ? AND run_id = ?').run(this.clock(), workspaceId, runId);
        this.#appendEvent({ workspaceId, runId, type: 'run.resumed', payload: { reason: 'worker_recovered', stepId: stepRow.step_id } });
      });
    }
    if (stepDef.kind === 'timer') {
      const action = this.#handleTimer({ workspaceId, runId, stepRow, stepDef, workerId });
      if (action === 'continue') {
        const nextClaim = this.#claim(workerId);
        if (nextClaim) return this.#workClaim(nextClaim, workerId);
      }
      return;
    }
    if (stepDef.kind === 'approval') return this.#handleApproval({ workspaceId, runId, stepRow, stepDef, workerId });
    return this.#handleActivity({ workspaceId, runId, stepRow, stepDef, workerId, definition });
  }

  #release(workspaceId, runId, workerId) {
    this.database.prepare('UPDATE runs SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE workspace_id = ? AND run_id = ? AND lease_owner = ?')
      .run(this.clock(), workspaceId, runId, workerId);
  }

  #completeStep({ workspaceId, runId, stepId, output, workerId }) {
    const now = this.clock();
    this.#transaction(() => {
      const run = this.#run(workspaceId, runId);
      if (!run || run.lease_owner !== workerId || TERMINAL.has(run.status)) return;
      this.database.prepare("UPDATE steps SET status = 'completed', output_json = ?, updated_at = ? WHERE workspace_id = ? AND run_id = ? AND step_id = ?")
        .run(boundedJson(output, 'step output', this.limits.stepOutputBytes), now, workspaceId, runId, stepId);
      this.#appendEvent({ workspaceId, runId, type: 'step.completed', payload: { stepId, summary: safeSummary(output) } });
      const remaining = this.database.prepare("SELECT COUNT(*) AS count FROM steps WHERE workspace_id = ? AND run_id = ? AND status != 'completed'").get(workspaceId, runId).count;
      if (Number(remaining) === 0) {
        const outputs = Object.fromEntries(this.#steps(workspaceId, runId).map((step) => [step.step_id, parseJson(step.output_json, null)]));
        this.database.prepare("UPDATE runs SET status = 'completed', output_json = ?, completed_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE workspace_id = ? AND run_id = ?")
          .run(boundedJson(outputs, 'run output', this.limits.stepOutputBytes * 2), now, now, workspaceId, runId);
        this.#appendEvent({ workspaceId, runId, type: 'run.completed', payload: { outputSteps: Object.keys(outputs) } });
      } else {
        this.database.prepare("UPDATE runs SET status = 'running', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE workspace_id = ? AND run_id = ?").run(now, workspaceId, runId);
      }
    });
  }

  #handleTimer({ workspaceId, runId, stepRow, stepDef, workerId }) {
    const now = this.clock();
    if (stepRow.status !== 'waiting_timer') {
      const delay = Math.max(1, Math.min(this.limits.timerHorizonMs, Number(stepDef.timer?.delayMs ?? 1)));
      const dueAt = addMs(now, delay);
      this.#transaction(() => {
        this.database.prepare("UPDATE steps SET status = 'waiting_timer', next_at = ?, updated_at = ? WHERE workspace_id = ? AND run_id = ? AND step_id = ?").run(dueAt, now, workspaceId, runId, stepRow.step_id);
        this.database.prepare("UPDATE runs SET status = 'waiting_timer', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE workspace_id = ? AND run_id = ?").run(now, workspaceId, runId);
        this.#appendEvent({ workspaceId, runId, type: 'timer.scheduled', payload: { stepId: stepRow.step_id, dueAt } });
        this.#appendEvent({ workspaceId, runId, type: 'run.suspended', payload: { reason: 'timer', stepId: stepRow.step_id } });
      });
      return;
    }
    if (!isDue(stepRow.next_at, now)) return this.#release(workspaceId, runId, workerId);
    this.#transaction(() => {
      this.#appendEvent({ workspaceId, runId, type: 'timer.fired', payload: { stepId: stepRow.step_id } });
    });
    this.#completeStep({ workspaceId, runId, stepId: stepRow.step_id, output: { firedAt: now }, workerId });
    return 'continue';
  }

  #handleApproval({ workspaceId, runId, stepRow, stepDef, workerId }) {
    const now = this.clock();
    if (stepRow.status === 'approval_resolved') {
      return this.#completeStep({ workspaceId, runId, stepId: stepRow.step_id, output: { approved: true, resolvedAt: now }, workerId });
    }
    const approvalId = stepRow.approval_id ?? prefixedId('app');
    const operationFingerprint = stepDef.approval?.operationFingerprint ?? `sha256:${sha256({ workspaceId, runId, stepId: stepRow.step_id })}`;
    const expiresAt = addMs(now, Math.max(1, Math.min(this.limits.approvalWaitMs, Number(stepDef.approval?.expiresInMs ?? 60000))));
    this.#transaction(() => {
      this.database.prepare(`
        INSERT OR IGNORE INTO approvals(workspace_id, run_id, approval_id, step_id, operation_fingerprint, state, requested_at, expires_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(workspaceId, runId, approvalId, stepRow.step_id, operationFingerprint, now, expiresAt);
      this.database.prepare("UPDATE steps SET status = 'waiting_approval', approval_id = ?, operation_fingerprint = ?, updated_at = ? WHERE workspace_id = ? AND run_id = ? AND step_id = ?")
        .run(approvalId, operationFingerprint, now, workspaceId, runId, stepRow.step_id);
      this.database.prepare("UPDATE runs SET status = 'waiting_approval', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE workspace_id = ? AND run_id = ?").run(now, workspaceId, runId);
      this.#appendEvent({ workspaceId, runId, type: 'approval.requested', payload: { approvalId, stepId: stepRow.step_id, operationFingerprint, expiresAt } });
      this.#appendEvent({ workspaceId, runId, type: 'run.suspended', payload: { reason: 'approval', stepId: stepRow.step_id } });
    });
  }

  async #handleActivity({ workspaceId, runId, stepRow, stepDef, workerId }) {
    const handler = this.registry.get(stepDef.handler);
    const attempt = Number(stepRow.attempt) + 1;
    const now = this.clock();
    const idempotencyRequired = stepDef.idempotency?.required === true;
    const idempotencyKey = idempotencyRequired ? (stepDef.idempotency?.key ?? `idem:${workspaceId}:${runId}:${stepRow.step_id}`) : null;
    const operationFingerprint = idempotencyRequired ? (stepDef.idempotency?.operationFingerprint ?? `sha256:${sha256({ workflowId: stepDef.id, handler: stepDef.handler })}`) : null;
    if (idempotencyRequired && !idempotencyKey) throw workflowError('idempotency_key_required', `step ${stepRow.step_id} requires idempotency`);
    if (idempotencyRequired) {
      const existing = this.database.prepare('SELECT * FROM effects WHERE workspace_id = ? AND idempotency_key = ?').get(workspaceId, idempotencyKey);
      if (existing) {
        if (existing.operation_fingerprint !== operationFingerprint) throw workflowError('idempotency_fingerprint_conflict', 'same idempotency key has different operation fingerprint');
        return this.#completeStep({ workspaceId, runId, stepId: stepRow.step_id, output: parseJson(existing.output_json, {}), workerId });
      }
    }
    this.#transaction(() => {
      const run = this.#run(workspaceId, runId);
      if (!run || run.lease_owner !== workerId || TERMINAL.has(run.status)) return;
      this.database.prepare("UPDATE steps SET status = 'running', attempt = ?, idempotency_key = ?, operation_fingerprint = ?, updated_at = ? WHERE workspace_id = ? AND run_id = ? AND step_id = ?")
        .run(attempt, idempotencyKey, operationFingerprint, now, workspaceId, runId, stepRow.step_id);
      this.database.prepare("UPDATE runs SET status = 'running', updated_at = ? WHERE workspace_id = ? AND run_id = ?").run(now, workspaceId, runId);
      this.#appendEvent({ workspaceId, runId, type: 'step.started', payload: { stepId: stepRow.step_id, kind: stepDef.kind, attempt } });
    });
    const abort = new AbortController();
    this.active.set(`${workspaceId}:${runId}`, abort);
    const timeout = timeoutPromise(stepDef.timeoutMs, abort);
    try {
      const priorOutputs = Object.fromEntries(this.#steps(workspaceId, runId).filter((step) => step.status === 'completed').map((step) => [step.step_id, parseJson(step.output_json, null)]));
      const workflowInput = parseJson(this.#run(workspaceId, runId).input_json, {});
      const context = {
        workspaceId,
        runId,
        stepId: stepRow.step_id,
        attempt,
        workflowInput,
        priorOutputs,
        idempotencyKey,
        signal: abort.signal,
        clock: this.clock,
        emitEvent: async (type, payload) => this.#transaction(() => this.#appendEvent({ workspaceId, runId, type, payload })),
        effect: async ({ idempotencyKey: key = idempotencyKey, operationFingerprint: fingerprint = operationFingerprint, execute }) => this.#commitEffect({ workspaceId, runId, stepId: stepRow.step_id, idempotencyKey: key, operationFingerprint: fingerprint, execute })
      };
      const output = await Promise.race([handler.run(context), timeout.promise]);
      timeout.clear();
      const latest = this.#run(workspaceId, runId);
      if (!latest || TERMINAL.has(latest.status) || latest.lease_owner !== workerId) return;
      this.#completeStep({ workspaceId, runId, stepId: stepRow.step_id, output, workerId });
    } catch (error) {
      timeout.clear();
      this.#handleFailure({ workspaceId, runId, stepRow, stepDef, workerId, attempt, error });
    } finally {
      this.active.delete(`${workspaceId}:${runId}`);
    }
  }

  async #commitEffect({ workspaceId, runId, stepId, idempotencyKey, operationFingerprint, execute }) {
    assertString(idempotencyKey, 'idempotencyKey');
    assertString(operationFingerprint, 'operationFingerprint');
    const existing = this.database.prepare('SELECT * FROM effects WHERE workspace_id = ? AND idempotency_key = ?').get(workspaceId, idempotencyKey);
    if (existing) {
      if (existing.operation_fingerprint !== operationFingerprint) throw workflowError('idempotency_fingerprint_conflict', 'same idempotency key has different operation fingerprint');
      return parseJson(existing.output_json, {});
    }
    const output = await execute();
    const outputJson = boundedJson(output, 'effect output', this.limits.stepOutputBytes);
    this.#transaction(() => {
      const found = this.database.prepare('SELECT * FROM effects WHERE workspace_id = ? AND idempotency_key = ?').get(workspaceId, idempotencyKey);
      if (found) {
        if (found.operation_fingerprint !== operationFingerprint) throw workflowError('idempotency_fingerprint_conflict', 'same idempotency key has different operation fingerprint');
        return;
      }
      this.database.prepare('INSERT INTO effects(workspace_id, idempotency_key, operation_fingerprint, run_id, step_id, output_json, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(workspaceId, idempotencyKey, operationFingerprint, runId, stepId, outputJson, this.clock());
    });
    return output;
  }

  #handleFailure({ workspaceId, runId, stepRow, stepDef, workerId, attempt, error }) {
    const latest = this.#run(workspaceId, runId);
    if (!latest || latest.lease_owner !== workerId || TERMINAL.has(latest.status)) return;
    const code = error?.code ?? 'step_failed';
    if (code === 'run_cancelled') return;
    const message = sanitizeReason(error?.message ?? code);
    const maxAttempts = stepDef.retry?.maxAttempts ?? 1;
    const retryable = error?.retryable !== false && attempt < maxAttempts;
    const now = this.clock();
    this.#transaction(() => {
      this.database.prepare("UPDATE steps SET error_json = ?, updated_at = ? WHERE workspace_id = ? AND run_id = ? AND step_id = ?")
        .run(boundedJson({ code, message, retryable }, 'error payload', this.limits.errorPayloadBytes), now, workspaceId, runId, stepRow.step_id);
      this.#appendEvent({ workspaceId, runId, type: 'step.failed', payload: { stepId: stepRow.step_id, attempt, code, retryable } });
      if (retryable) {
        const delay = Math.max(1, Math.min(Number(stepDef.retry?.maxDelayMs ?? stepDef.retry?.initialDelayMs ?? 10), Number(stepDef.retry?.initialDelayMs ?? 10) * Math.max(1, attempt)));
        const nextAt = addMs(now, delay);
        this.database.prepare("UPDATE steps SET status = 'waiting_retry', next_at = ?, updated_at = ? WHERE workspace_id = ? AND run_id = ? AND step_id = ?")
          .run(nextAt, now, workspaceId, runId, stepRow.step_id);
        this.database.prepare("UPDATE runs SET status = 'waiting_retry', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE workspace_id = ? AND run_id = ?")
          .run(now, workspaceId, runId);
        this.#appendEvent({ workspaceId, runId, type: 'step.retry_scheduled', payload: { stepId: stepRow.step_id, attempt, nextAt } });
        this.#appendEvent({ workspaceId, runId, type: 'run.suspended', payload: { reason: 'retry', stepId: stepRow.step_id } });
      } else {
        this.database.prepare("UPDATE steps SET status = 'failed', updated_at = ? WHERE workspace_id = ? AND run_id = ? AND step_id = ?")
          .run(now, workspaceId, runId, stepRow.step_id);
        this.database.prepare("UPDATE runs SET status = 'failed', error_json = ?, completed_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE workspace_id = ? AND run_id = ?")
          .run(boundedJson({ code, message }, 'error payload', this.limits.errorPayloadBytes), now, now, workspaceId, runId);
        this.#appendEvent({ workspaceId, runId, type: 'run.failed', payload: { code } });
      }
    });
  }

  async runWorker({ workerId = `worker_${randomUUID().slice(0, 8)}`, signal = null, once = false, idleMs = 25, maxTicks = Infinity } = {}) {
    let ticks = 0;
    while (!signal?.aborted && ticks < maxTicks) {
      const result = await this.tick({ workerId });
      ticks += 1;
      if (once || (!result.claimed && ticks >= maxTicks)) break;
      if (!result.claimed) await new Promise((resolve) => setTimeout(resolve, idleMs));
    }
    return { workerId, ticks, stopped: true };
  }

  close() {
    for (const controller of this.active.values()) controller.abort(workflowError('run_cancelled', 'runtime closed'));
    this.active.clear();
    this.database.close();
  }
}

function safeSummary(output) {
  if (output === null || output === undefined) return null;
  if (typeof output !== 'object') return { valueType: typeof output };
  const keys = Object.keys(output).sort().slice(0, 8);
  return { keys };
}

export function createDurableSmokeWorkflowDefinition({ includeWaits = true } = {}) {
  const steps = [
    {
      id: 'activity',
      kind: 'deterministic',
      handler: { id: 'handler:smoke:activity', version: '1.0.0' },
      timeoutMs: 1000,
      retry: { maxAttempts: 1 },
      approval: { required: false },
      idempotency: { required: false },
      riskClass: 'read-only',
      inputSchema: {},
      outputSchema: {}
    },
    {
      id: 'retry',
      kind: 'deterministic',
      handler: { id: 'handler:smoke:retry', version: '1.0.0' },
      timeoutMs: 1000,
      retry: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 50, retryableCodes: ['planned_retry'] },
      approval: { required: false },
      idempotency: { required: false },
      riskClass: 'read-only',
      inputSchema: {},
      outputSchema: {}
    }
  ];
  if (includeWaits) {
    steps.push(
      {
        id: 'timer',
        kind: 'timer',
        timer: { delayMs: 500 },
        timeoutMs: 1000,
        retry: { maxAttempts: 1 },
        approval: { required: false },
        idempotency: { required: false },
        riskClass: 'read-only',
        inputSchema: {},
        outputSchema: {}
      },
      {
        id: 'approval',
        kind: 'approval',
        timeoutMs: 1000,
        retry: { maxAttempts: 1 },
        approval: { required: true, operationFingerprint: 'sha256:approval-smoke', expiresInMs: 60000 },
        idempotency: { required: false },
        riskClass: 'consequential-write',
        inputSchema: {},
        outputSchema: {}
      }
    );
  }
  steps.push(
    {
      id: 'effect',
      kind: 'activity',
      handler: { id: 'handler:smoke:effect', version: '1.0.0' },
      timeoutMs: 5000,
      retry: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 50 },
      approval: { required: false },
      idempotency: { required: true, operationFingerprint: 'sha256:effect-smoke' },
      riskClass: 'read-only',
      inputSchema: {},
      outputSchema: {}
    },
    {
      id: 'final',
      kind: 'deterministic',
      handler: { id: 'handler:smoke:final', version: '1.0.0' },
      timeoutMs: 1000,
      retry: { maxAttempts: 1 },
      approval: { required: false },
      idempotency: { required: false },
      riskClass: 'read-only',
      inputSchema: {},
      outputSchema: {}
    }
  );
  return {
    schemaVersion: '1.0.0',
    id: 'workflow:durable-smoke',
    version: '1.0.0',
    name: 'Durable workflow smoke',
    description: 'Local durable SQLite workflow smoke fixture for OAF-014.',
    steps
  };
}

export function createDurableSmokeWorkflowRegistry({ effectFile = null, afterEffect = null } = {}) {
  const registry = new DurableWorkflowHandlerRegistry();
  registry.register({
    id: 'handler:smoke:activity',
    version: '1.0.0',
    capabilities: ['deterministic.local'],
    run: async ({ workflowInput }) => ({ objective: workflowInput.objective ?? null })
  });
  registry.register({
    id: 'handler:smoke:retry',
    version: '1.0.0',
    capabilities: ['deterministic.local'],
    run: async ({ attempt }) => {
      if (attempt === 1) {
        const error = workflowError('planned_retry', 'planned durable retry');
        error.retryable = true;
        throw error;
      }
      return { attempt, recovered: true };
    }
  });
  registry.register({
    id: 'handler:smoke:effect',
    version: '1.0.0',
    capabilities: ['local.effect-reference'],
    run: async ({ effect, idempotencyKey }) => {
      const result = await effect({
        idempotencyKey,
        operationFingerprint: 'sha256:effect-smoke',
        execute: async () => {
          let count = 0;
          if (effectFile) {
            try { count = JSON.parse(readFileSync(effectFile, 'utf8')).count ?? 0; } catch {}
            count += 1;
            writeFileSync(effectFile, JSON.stringify({ count }, null, 2));
          } else {
            count = 1;
          }
          return { effectCount: count };
        }
      });
      if (afterEffect) await afterEffect(result);
      return result;
    }
  });
  registry.register({
    id: 'handler:smoke:final',
    version: '1.0.0',
    capabilities: ['deterministic.local'],
    run: async ({ priorOutputs }) => ({ completedSteps: Object.keys(priorOutputs).sort(), effectCount: priorOutputs.effect?.effectCount ?? 0 })
  });
  return registry;
}
