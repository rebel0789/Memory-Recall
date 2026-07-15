export class ApiRequestError extends Error {
  constructor(message, { status = null, code = '', correlationId = '', issues = [] } = {}) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
    this.issues = issues;
  }
}

export async function requestJson(path, { method = 'GET', body, signal, headers: inputHeaders } = {}) {
  const headers = new Headers(inputHeaders ?? {});
  if (body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!['GET', 'HEAD'].includes(method)) {
    const token = csrfToken();
    if (token) headers.set('x-csrf-token', token);
  }
  const response = await fetch(path, {
    method,
    body,
    signal,
    headers,
    credentials: 'same-origin'
  });
  const payload = await readPayload(response);
  if (!response.ok) throw apiError(response, payload);
  return payload;
}

export function csrfToken() {
  return /(?:^|;\s*)oaf_csrf=([^;]+)/u.exec(globalThis.document?.cookie ?? '')?.[1] ?? '';
}

async function readPayload(response) {
  return response.clone().json().catch(() => null);
}

function apiError(response, payload) {
  const code = payload?.error?.code ?? '';
  const message = code === 'bootstrap_required'
    ? 'Local owner setup is required.'
    : code === 'invalid_credentials'
      ? 'Username or password is incorrect.'
      : response.status === 401
        ? 'Local authentication required.'
        : payload?.error?.message ?? `Request failed with ${response.status}`;
  return new ApiRequestError(message, {
    status: response.status,
    code,
    correlationId: payload?.error?.correlationId ?? response.headers.get('x-correlation-id') ?? '',
    issues: Array.isArray(payload?.error?.issues) ? payload.error.issues : []
  });
}
