import { prefixedId, nowIso } from '../../../../packages/protocol/src/index.mjs';
import { executeSteps } from '../../../../packages/workflow-runtime/src/index.mjs';
import { FileStateStore } from '../../../../packages/storage/src/file-store.mjs';

const PROVIDER_ID = 'provider:native:workflow:embedded';

export class EmbeddedWorkflowRuntime {
  constructor({ store = new FileStateStore('.local'), clock = nowIso } = {}) {
    this.store = store;
    this.clock = clock;
    this.controllers = new Map();
    this.initialized = false;
  }

  async #init() {
    if (!this.initialized) {
      await this.store.init();
      this.initialized = true;
    }
  }

  async health() {
    await this.#init();
    return { status: 'healthy', local: true, details: { provider: PROVIDER_ID, processRecovery: false, activeRuns: this.controllers.size } };
  }

  async capabilities() {
    return ['workflow.start', 'workflow.inspect', 'workflow.cancel', 'workflow.event-checkpoint'];
  }

  async registerWorkflow() {
    const error = new Error('embedded workflow runtime does not register durable serializable workflows');
    error.code = 'workflow_capability_unsupported';
    throw error;
  }

  async start({ runId = prefixedId('run'), workspaceId = 'ws_local', workflowId = 'workflow:anonymous', steps }) {
    await this.#init();
    if (this.controllers.has(runId)) throw new Error(`run already active: ${runId}`);
    const existing = (await this.store.read()).runs.find((run) => run.id === runId && run.workspaceId === workspaceId);
    if (existing) throw new Error(`run already exists: ${runId}`);
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    const createdAt = this.clock();
    await this.store.update((state) => {
      state.runs.push({ id: runId, workspaceId, workflowId, status: 'running', provider: PROVIDER_ID, createdAt, updatedAt: createdAt });
      return state;
    });
    try {
      const result = await executeSteps({
        runId,
        workspaceId,
        steps,
        signal: controller.signal,
        emit: async (event) => {
          await this.store.update((state) => {
            state.events.push(event);
            const run = state.runs.find((item) => item.id === runId && item.workspaceId === workspaceId);
            if (run) run.updatedAt = event.occurredAt;
            return state;
          });
        }
      });
      await this.store.update((state) => {
        const run = state.runs.find((item) => item.id === runId && item.workspaceId === workspaceId);
        if (run) {
          run.status = result.status;
          run.updatedAt = this.clock();
          run.outputSteps = Object.keys(result.outputs);
          run.error = result.error ?? null;
        }
        return state;
      });
      return { runId, ...result };
    } finally {
      this.controllers.delete(runId);
    }
  }

  async get({ runId, workspaceId = 'ws_local' }) {
    await this.#init();
    const state = await this.store.read();
    const run = state.runs.find((item) => item.id === runId && item.workspaceId === workspaceId);
    if (!run) return null;
    return { ...run, events: state.events.filter((event) => event.runId === runId && event.workspaceId === workspaceId).sort((a, b) => a.sequence - b.sequence) };
  }

  async list({ workspaceId = 'ws_local', limit = 50 } = {}) {
    await this.#init();
    const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const state = await this.store.read();
    return {
      schemaVersion: '1.0.0',
      items: state.runs
        .filter((item) => item.workspaceId === workspaceId)
        .slice()
        .reverse()
        .slice(0, boundedLimit)
    };
  }

  async cancel({ runId, workspaceId = 'ws_local', reason = 'cancelled by operator' }) {
    await this.#init();
    const controller = this.controllers.get(runId);
    if (!controller) {
      const existing = await this.get({ runId, workspaceId });
      return { cancelled: false, reason: existing ? `run is ${existing.status}` : 'run not found' };
    }
    controller.abort(reason);
    return { cancelled: true, reason };
  }

  async signal() {
    const error = new Error('embedded workflow runtime does not support durable signals');
    error.code = 'workflow_capability_unsupported';
    throw error;
  }

  async resolveApproval() {
    const error = new Error('embedded workflow runtime does not support durable approval waits');
    error.code = 'workflow_capability_unsupported';
    throw error;
  }

  async tick() {
    return { claimed: false, reason: 'embedded runtime has no durable worker queue' };
  }

  async runWorker({ signal } = {}) {
    if (signal?.aborted) return { ticks: 0, stopped: true };
    return { ticks: 0, stopped: true };
  }

  async history({ runId, workspaceId = 'ws_local' }) {
    const run = await this.get({ runId, workspaceId });
    return { schemaVersion: '1.0.0', workspaceId, runId, events: run?.events ?? [] };
  }

  close() {}
}

export { PROVIDER_ID as EMBEDDED_WORKFLOW_PROVIDER_ID };
