import { createEvent } from '../../protocol/src/index.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cancelledError(reason = 'run cancelled') {
  const error = new Error(typeof reason === 'string' ? reason : 'run cancelled');
  error.code = 'run_cancelled';
  error.retryable = false;
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw cancelledError(signal.reason);
}

async function withTimeout(promise, ms, signal) {
  let timer;
  let abortListener;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`step timed out after ${ms}ms`);
      error.code = 'step_timeout';
      error.retryable = true;
      reject(error);
    }, ms);
  });
  const cancellation = signal
    ? new Promise((_, reject) => {
        abortListener = () => reject(cancelledError(signal.reason));
        signal.addEventListener('abort', abortListener, { once: true });
      })
    : new Promise(() => {});
  try {
    throwIfAborted(signal);
    return await Promise.race([promise, timeout, cancellation]);
  } finally {
    clearTimeout(timer);
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
}

export async function executeSteps({ runId, workspaceId = 'ws_local', steps, emit = async () => {}, signal = null }) {
  if (!runId) throw new Error('runId is required');
  if (!Array.isArray(steps) || !steps.length) throw new Error('steps must be a non-empty array');
  const outputs = {};
  const events = [];
  let sequence = 0;
  const append = async (type, payload, actorId = 'system') => {
    const event = createEvent({ workspaceId, type, runId, actorId, payload, sequence: sequence++ });
    events.push(event);
    await emit(event);
    return event;
  };

  await append('run.created', { steps: steps.map((step) => step.id) });
  await append('run.started', {});
  try {
    for (const step of steps) {
      throwIfAborted(signal);
      const maxAttempts = Math.max(1, step.retry?.maxAttempts ?? 1);
      let lastError;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        throwIfAborted(signal);
        await append('step.started', { stepId: step.id, kind: step.kind, attempt }, step.actorId ?? 'system');
        try {
          const output = await withTimeout(
            Promise.resolve(step.run({ outputs, attempt, emitEvent: append, signal })),
            step.timeoutMs ?? 30000,
            signal
          );
          outputs[step.id] = output;
          await append('step.completed', { stepId: step.id, attempt, summary: step.summarize?.(output) ?? null }, step.actorId ?? 'system');
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (error.code === 'run_cancelled') {
            await append('step.cancelled', { stepId: step.id, attempt, message: error.message }, step.actorId ?? 'system');
            throw error;
          }
          await append('step.failed', { stepId: step.id, attempt, code: error.code ?? 'step_failed', message: error.message, retryable: Boolean(error.retryable) }, step.actorId ?? 'system');
          if (attempt < maxAttempts && error.retryable !== false) await sleep(Math.min(100, 10 * attempt));
          else throw error;
        }
      }
      if (lastError) throw lastError;
    }
    await append('run.completed', { outputSteps: Object.keys(outputs) });
    return { status: 'completed', outputs, events };
  } catch (error) {
    if (error.code === 'run_cancelled') {
      await append('run.cancelled', { code: error.code, message: error.message });
      return { status: 'cancelled', outputs, events, error: { code: error.code, message: error.message } };
    }
    await append('run.failed', { code: error.code ?? 'run_failed', message: error.message });
    return { status: 'failed', outputs, events, error: { code: error.code ?? 'run_failed', message: error.message } };
  }
}
