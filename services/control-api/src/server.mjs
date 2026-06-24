import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FileStateStore } from '../../../packages/storage/src/file-store.mjs';
import { LocalIdentityStore, hashOpaqueSecret } from '../../../providers/native/identity-local/src/index.mjs';
import { FilesystemContextManifestRepository } from '../../../providers/native/context-manifest-local/src/index.mjs';
import { runContentIntelligence } from '../../../workflows/content-intelligence/runner.mjs';
import { compileAndPersistContext, compileContext as defaultCompileContext } from '../../../packages/context-compiler/src/index.mjs';
import { buildContextPack, buildHarnessSetupReport, renderContextPackMarkdown } from '../../../packages/harness-context/src/index.mjs';
import { buildSourceGraphPreview } from '../../../packages/source-graph/src/index.mjs';
import { actionsForRole, createPolicyService } from '../../../packages/policy/src/index.mjs';
import { assertJsonSchema, validateJsonSchema } from '../../../packages/protocol/src/schema-validator.mjs';
import { createTelemetryFromEnv, createTraceContext, routeSpanAttributes } from '../../../packages/observability/src/index.mjs';
import { API_ERROR_SCHEMA, createApiRouteContracts } from './route-contracts.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../../../apps/web');
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const DEFAULT_LIMITS = Object.freeze({
  bodyBytes: 1_000_000,
  urlBytes: 4096,
  pathSegmentBytes: 128,
  queryParameters: 16,
  queryValueBytes: 512,
  headerBytes: 16 * 1024,
  headerCount: 100,
  jsonDepth: 20,
  jsonNodes: 10_000,
  jsonObjectKeys: 100,
  jsonArrayItems: 1000,
  objectiveLength: 2000
});

const PUBLIC_MESSAGES = Object.freeze({
  invalid_json: 'Request body must be valid JSON.',
  request_validation_failed: 'The request did not match the API contract.',
  invalid_path_parameter: 'The request path did not match the API contract.',
  route_not_found: 'Route not found.',
  method_not_allowed: 'Method is not allowed for this route.',
  request_too_large: 'Request body exceeds the configured limit.',
  unsupported_media_type: 'The request media type is not supported.',
  unsupported_content_encoding: 'Compressed request bodies are not supported.',
  authentication_required: 'Authentication is required.',
  invalid_credentials: 'Invalid credentials.',
  invalid_authentication: 'Authentication credentials are invalid.',
  csrf_failed: 'CSRF validation failed.',
  forbidden: 'The authenticated principal is not allowed to perform this action.',
  resource_not_found: 'Resource not found.',
  already_bootstrapped: 'Identity bootstrap has already completed.',
  workspace_context_conflict: 'Workspace context is ambiguous or conflicting.',
  rate_limited: 'Too many authentication attempts.',
  bootstrap_required: 'Identity bootstrap is required before this operation.',
  internal_error: 'The local control API could not complete the request.'
});

const VALID_CORRELATION_ID = /^req_[A-Za-z0-9._:-]{8,96}$/;
const SAFE_RUN_ID = /^run_[A-Za-z0-9._:-]{1,120}$/;
const SAFE_WORKSPACE_ID = /^ws_[A-Za-z0-9._:-]{1,120}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SESSION_COOKIE = 'oaf_session';
const CSRF_COOKIE = 'oaf_csrf';

class ApiError extends Error {
  constructor(status, code, message = PUBLIC_MESSAGES[code], { issues = [], headers = {}, logCode = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
    this.headers = headers;
    this.logCode = logCode;
  }
}

export function createControlApiServer({
  store,
  runWorkflow = runContentIntelligence,
  compileContext = defaultCompileContext,
  manifestRepository = null,
  sourceGraphRoot = path.resolve(here, '../../..'),
  harnessSetupHome = process.env.HOME ?? process.cwd(),
  identityStore = createUnavailableIdentityStore(),
  loginRateLimiter = createLoginRateLimiter({ clock: () => Date.now() }),
  policyService = null,
  clock = () => new Date().toISOString(),
  correlationIdFactory = () => `req_${randomUUID()}`,
  limits = {},
  logger = console,
  allowedHosts = [...LOOPBACK_HOSTS],
  telemetry = createTelemetryFromEnv(process.env)
} = {}) {
  if (!store) throw new Error('createControlApiServer requires store');
  const effectiveLimits = { ...DEFAULT_LIMITS, ...limits };
  const contracts = createApiRouteContracts(effectiveLimits);
  const effectivePolicyService = policyService ?? createPolicyService({
    auditSink: identityStore,
    clock,
    decisionIdFactory: () => `poldet_${randomUUID()}`
  });
  const streams = new Set();

  const server = http.createServer(async (request, response) => {
    const started = Date.now();
    const correlationId = selectCorrelationId(request.headers['x-correlation-id'], correlationIdFactory);
    try {
      if (String(request.url ?? '').startsWith('/api/')) {
        await handleApi({ request, response, correlationId, started });
        return;
      }
      await serveStatic(response, request.url ?? '/');
    } catch (error) {
      sendError(response, mapError(error), correlationId, { logger, started, operationId: error.operationId ?? null });
    }
  });

  async function handleApi({ request, response, correlationId, started }) {
    enforceHost(request, allowedHosts);
    enforceUrlAndHeaderLimits(request, effectiveLimits);
    const parsed = parseRequestUrl(request);
    const matched = matchContract(contracts, request.method, parsed.pathname);
    if (matched.methodNotAllowed) {
      throw new ApiError(405, 'method_not_allowed', PUBLIC_MESSAGES.method_not_allowed, { headers: { allow: matched.allow.join(', ') } });
    }
    if (!matched.contract) throw new ApiError(404, 'route_not_found');
    const { contract, pathParameters } = matched;
    validateOrigin(request, contract, parsed);
    const params = validatePathParameters(contract, pathParameters);
    const query = validateQuery(contract, parsed.searchParams, effectiveLimits);
    const body = await readAndValidateBody(request, contract, effectiveLimits);
    const auth = await authenticateAndAuthorize({ request, contract, parsed, query, body, correlationId });

    if (contract.streams) {
      return sendStream({ request, response, correlationId, started, workspaceId: auth.workspaceId });
    }

    const statusCode = 200 in contract.responses ? 200 : 201;
    const traceContext = createTraceContext({ correlationId, workspaceId: auth.workspaceId });
    const span = telemetry.startSpan('oaf.control-api.route', routeSpanAttributes({ operationId: contract.operationId, method: request.method, route: contract.path, statusCode, workspaceId: auth.workspaceId, correlationId }), traceContext);
    try {
      const payload = await executeOperation(contract, { params, query, body, correlationId, principal: auth.principal, workspaceId: auth.workspaceId, response, request, traceContext, telemetry });
      sendValidatedJson(response, contract, statusCode, payload, correlationId);
      span.end('ok', routeSpanAttributes({ operationId: contract.operationId, method: request.method, route: contract.path, statusCode, workspaceId: auth.workspaceId, correlationId }));
      safeLog(logger, 'info', { code: 'request_completed', operationId: contract.operationId, status: statusCode, correlationId, durationMs: Date.now() - started });
    } catch (error) {
      span.end('error', routeSpanAttributes({ operationId: contract.operationId, method: request.method, route: contract.path, statusCode: error.status ?? 500, workspaceId: auth.workspaceId, correlationId }));
      throw error;
    }
  }

  async function executeOperation(contract, context) {
    switch (contract.operationId) {
      case 'getHealth':
        return {
          schemaVersion: '1.0.0',
          status: 'ok',
          mode: 'local-bootstrap',
          version: '0.2.0-dev',
          residency: 'local-only',
          externalWrites: false,
          time: clock()
        };
      case 'getBootstrapStatus':
        return { schemaVersion: '1.0.0', bootstrapRequired: !await identityStore.isBootstrapped() };
      case 'bootstrapOwner':
        return bootstrapOwner(context);
      case 'login':
        return login(context);
      case 'getSession':
        return sessionPayload(context.principal);
      case 'logout':
        await identityStore.revokeSession({ sessionId: context.principal.session.id, actorUserId: context.principal.user.id });
        setLogoutCookies(context.response, context.request);
        return { schemaVersion: '1.0.0', loggedOut: true };
      case 'createApiToken': {
        const created = await identityStore.createApiToken({
          actorUserId: context.principal.user.id,
          name: context.body.name,
          workspaceIds: context.body.workspaceIds,
          scopes: context.body.scopes,
          expiresAt: context.body.expiresAt ?? null
        });
        return { schemaVersion: '1.0.0', apiToken: created.apiToken, token: created.token };
      }
      case 'listApiTokens':
        return { schemaVersion: '1.0.0', items: await identityStore.listApiTokens({ userId: context.principal.user.id }) };
      case 'deleteApiToken':
        return { schemaVersion: '1.0.0', ...(await identityStore.revokeApiToken({ tokenId: context.params.tokenId, actorUserId: context.principal.user.id })) };
      case 'getProjectStatus':
        return JSON.parse(await readFile(path.resolve(here, '../../../PROJECT_STATUS.json'), 'utf8'));
      case 'getDashboard': {
        const state = await store.read();
        const runs = state.runs.filter((run) => run.workspaceId === context.workspaceId);
        const events = state.events.filter((event) => event.workspaceId === context.workspaceId);
        const memories = state.memories.filter((memory) => (memory.workspaceId ?? context.workspaceId) === context.workspaceId);
        const approvals = state.approvals.filter((approval) => (approval.workspaceId ?? context.workspaceId) === context.workspaceId);
        const latestRun = runs.at(-1) ?? null;
        const latestManifest = [...events].reverse().find((event) => event.type === 'context.compiled')?.payload ?? null;
        return {
          metrics: {
            runs: runs.length,
            completed: runs.filter((run) => run.status === 'completed').length,
            events: events.length,
            memories: memories.length,
            pendingApprovals: approvals.filter((approval) => approval.status === 'pending').length
          },
          latestRun,
          latestManifest,
          runs: runs.slice(-8).reverse(),
          memories: memories.slice(-20).reverse(),
          approvals: approvals.slice(-20).reverse(),
          artifacts: state.artifacts.filter((artifact) => (artifact.workspaceId ?? context.workspaceId) === context.workspaceId).slice(-20).reverse()
        };
      }
      case 'listRuns': {
        const state = await store.read();
        return { schemaVersion: '1.0.0', items: state.runs.filter((run) => run.workspaceId === context.workspaceId).slice().reverse() };
      }
      case 'getRun': {
        const state = await store.read();
        const run = state.runs.find((item) => item.id === context.params.runId && item.workspaceId === context.workspaceId);
        if (!run) throw new ApiError(404, 'resource_not_found');
        return {
          schemaVersion: '1.0.0',
          run,
          events: state.events.filter((event) => event.runId === context.params.runId && event.workspaceId === context.workspaceId).sort((a, b) => a.sequence - b.sequence)
        };
      }
      case 'startRun': {
        const workflowId = context.body.workflowId ?? 'workflow:content-intelligence';
        const events = [];
        const result = await runWorkflow({
          objective: context.body.objective,
          workspaceId: context.workspaceId,
          actorId: context.principal.user.id,
          manifestRepository,
          emit: async (event) => {
            const correlated = { ...event, workspaceId: context.workspaceId, actorId: context.principal.user.id, correlationId: context.correlationId };
            events.push(correlated);
            broadcast(correlated);
          },
          telemetry: context.telemetry,
          traceContext: context.traceContext,
          correlationId: context.correlationId
        });
        const run = {
          id: result.runId,
          workspaceId: context.workspaceId,
          workflowId,
          workflowVersion: '0.1.0',
          objective: result.objective,
          status: result.status,
          residency: 'local-only',
          createdAt: events.at(0)?.occurredAt ?? clock(),
          completedAt: events.at(-1)?.occurredAt ?? null,
          output: result.outputs?.['generate-angles'] ?? null,
          verification: result.outputs?.['verify-recommendations'] ?? null
        };
        await store.update((state) => {
          state.runs.push(run);
          state.events.push(...events);
          return state;
        });
        return { schemaVersion: '1.0.0', run, events };
      }
      case 'compileContext':
        if (manifestRepository) {
          const result = await compileAndPersistContext(context.body.request, context.body.records, {
            manifestRepository,
            runId: null,
            clock,
            emitEvent: async () => {}
          });
          return result.manifest;
        }
        return compileContext(context.body.request, context.body.records);
      case 'buildContextPack': {
        const pack = await buildContextPack({
          root: path.resolve(here, '../../..'),
          harnesses: normalizeHarnesses(context.body.from ?? 'all'),
          userSelectedFiles: context.body.userSelectedFiles ?? [],
          changedLocators: context.body.changedLocators ?? [],
          workspaceId: context.workspaceId,
          targetHarness: context.body.targetHarness ?? 'generic',
          objective: context.body.objective,
          step: context.body.step,
          tokenBudget: context.body.tokenBudget ?? 4096,
          clock
        });
        return { schemaVersion: '1.0.0', pack, markdown: renderContextPackMarkdown(pack) };
      }
      case 'previewContextGraph':
        return buildSourceGraphPreview({
          root: sourceGraphRoot,
          workspaceId: context.workspaceId,
          query: context.body.query ?? '',
          startName: context.body.startName ?? null,
          startNodeId: context.body.startNodeId ?? null,
          changedLocators: context.body.changedLocators ?? [],
          nodeKinds: context.body.nodeKinds ?? null,
          edgeKinds: context.body.edgeKinds ?? null,
          labelPattern: context.body.labelPattern ?? null,
          locatorPrefix: context.body.locatorPrefix ?? null,
          direction: context.body.direction ?? 'outbound',
          limit: context.body.limit ?? 20,
          offset: context.body.offset ?? 0,
          depth: context.body.depth ?? 2,
          sampleLimit: context.body.sampleLimit ?? 12,
          maxFiles: context.body.maxFiles ?? 200,
          maxFileBytes: context.body.maxFileBytes ?? 128 * 1024,
          clock
        });
      case 'planHarnessSetup':
        return buildHarnessSetupReport({
          action: 'plan',
          client: context.body.client,
          server: 'oaf',
          home: harnessSetupHome,
          generatedAt: clock()
        });
      case 'resetBootstrap':
        await store.reset();
        return { schemaVersion: '1.0.0', reset: true, time: clock() };
      default:
        throw new ApiError(500, 'internal_error');
    }
  }

  async function login({ body, request, response }) {
    if (!await identityStore.isBootstrapped()) throw new ApiError(503, 'bootstrap_required');
    const remoteAddress = request.socket?.remoteAddress ?? 'unknown';
    const limit = loginRateLimiter.check({ remoteAddress, username: body.username, now: Date.now() });
    if (!limit.allowed) throw new ApiError(429, 'rate_limited', PUBLIC_MESSAGES.rate_limited, { headers: { 'retry-after': String(limit.retryAfterSeconds) } });
    const verified = await identityStore.verifyPassword({ username: body.username, password: body.password });
    if (!verified.ok) throw new ApiError(401, 'invalid_credentials', PUBLIC_MESSAGES.invalid_credentials, { headers: { 'www-authenticate': 'Bearer' } });
    const session = await identityStore.createSession({
      userId: verified.user.id,
      remoteAddress,
      userAgent: request.headers['user-agent'] ?? null
    });
    setLoginCookies(response, request, session);
    return sessionPayload({
      credentialType: 'session',
      user: verified.user,
      memberships: await identityStore.listMemberships({ userId: verified.user.id }),
      session: session.session
    });
  }

  async function bootstrapOwner({ body, request, response }) {
    try {
      const created = await identityStore.bootstrapOwner({
        username: body.username,
        displayName: body.displayName,
        password: body.password,
        workspaceId: body.workspaceId ?? 'ws_local',
        workspaceName: body.workspaceName ?? 'Local Workspace'
      });
      const session = await identityStore.createSession({
        userId: created.user.id,
        remoteAddress: request.socket?.remoteAddress ?? 'unknown',
        userAgent: request.headers['user-agent'] ?? null
      });
      setLoginCookies(response, request, session);
      return sessionPayload({
        credentialType: 'session',
        user: created.user,
        memberships: [created.membership],
        session: session.session
      });
    } catch (error) {
      if (error?.code === 'already_bootstrapped') throw new ApiError(409, 'already_bootstrapped');
      throw error;
    }
  }

  async function authenticateAndAuthorize({ request, contract, parsed, query, body, correlationId }) {
    if (contract.security?.public) return { principal: null, workspaceId: null };
    if (!await identityStore.isBootstrapped()) throw new ApiError(503, 'bootstrap_required');
    const credentials = extractCredentials(request, parsed);
    const principal = await authenticateCredentials(credentials);
    if (!principal) {
      await identityStore.recordAuditEvent({ type: 'auth.authentication', outcome: 'deny', correlationId, metadata: { route: contract.operationId } });
      throw new ApiError(401, 'authentication_required', PUBLIC_MESSAGES.authentication_required, { headers: { 'www-authenticate': 'Bearer' } });
    }
    const workspaceId = resolveWorkspaceContext(contract, query, body);
    const action = contract.security?.action ?? null;
    if (action) {
      const decision = await effectivePolicyService.evaluate(createRoutePolicyRequest({ principal, workspaceId, action, contract, correlationId, now: clock() }));
      if (contract.security?.sessionOnly === true && principal.credentialType !== 'session') {
        decision.outcome = 'deny';
        decision.reasonCodes = [...new Set([...decision.reasonCodes, 'resource_denied'])].sort();
      }
      if (decision.outcome !== 'allow') {
        throw new ApiError(contract.security?.resourceLookup ? 404 : 403, contract.security?.resourceLookup ? 'resource_not_found' : 'forbidden');
      }
    }
    if (contract.security?.csrf && principal.credentialType === 'session') {
      enforceCsrf({ request, principal });
    }
    return { principal, workspaceId };
  }

  async function authenticateCredentials(credentials) {
    if (credentials.type === 'invalid') throw new ApiError(401, 'invalid_authentication', PUBLIC_MESSAGES.invalid_authentication, { headers: { 'www-authenticate': 'Bearer' } });
    if (credentials.type === 'none') return null;
    if (credentials.type === 'session') {
      const result = await identityStore.authenticateSession({ token: credentials.token, now: clock() });
      if (!result) return null;
      return { credentialType: 'session', user: result.user, memberships: result.memberships, session: result.session, csrfHash: result.csrfHash };
    }
    if (credentials.type === 'bearer') {
      const result = await identityStore.authenticateApiToken({ token: credentials.token, now: clock() });
      if (!result) return null;
      return { credentialType: 'bearer', user: result.user, memberships: result.memberships, apiToken: result.apiToken };
    }
    return null;
  }

  function sendStream({ request, response, correlationId, started, workspaceId }) {
    response.writeHead(200, {
      ...securityHeaders(),
      'x-correlation-id': correlationId,
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive'
    });
    response.write(`event: connected\ndata: ${JSON.stringify({ time: clock(), correlationId })}\n\n`);
    const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 15000);
    const stream = { response, workspaceId };
    streams.add(stream);
    safeLog(logger, 'info', { code: 'stream_connected', operationId: 'streamEvents', status: 200, correlationId, durationMs: Date.now() - started });
    request.on('close', () => {
      clearInterval(heartbeat);
      streams.delete(stream);
      safeLog(logger, 'info', { code: 'stream_disconnected', operationId: 'streamEvents', status: 200, correlationId });
    });
  }

  function broadcast(event) {
    const message = `event: agent-event\ndata: ${JSON.stringify(event)}\n\n`;
    for (const stream of streams) {
      if (stream.workspaceId === event.workspaceId) stream.response.write(message);
    }
  }

  function close(callback) {
    for (const stream of streams) stream.response.end();
    server.close(callback);
  }

  return { server, close, contracts, activeStreamCount: () => streams.size };
}

function selectCorrelationId(value, factory) {
  const supplied = Array.isArray(value) ? value[0] : value;
  if (typeof supplied === 'string' && VALID_CORRELATION_ID.test(supplied)) return supplied;
  const generated = factory();
  return VALID_CORRELATION_ID.test(generated) ? generated : `req_${randomUUID()}`;
}

function enforceHost(request, allowedHosts) {
  const header = request.headers.host;
  if (!header) throw new ApiError(400, 'request_validation_failed', PUBLIC_MESSAGES.request_validation_failed, { issues: [{ path: '$.headers.host', code: 'required' }] });
  let hostname = header;
  if (hostname.startsWith('[')) hostname = hostname.slice(0, hostname.indexOf(']') + 1);
  else hostname = hostname.split(':')[0];
  if (!new Set(allowedHosts).has(hostname)) {
    throw new ApiError(400, 'request_validation_failed', PUBLIC_MESSAGES.request_validation_failed, { issues: [{ path: '$.headers.host', code: 'invalid_host' }] });
  }
}

function enforceUrlAndHeaderLimits(request, limits) {
  const urlBytes = Buffer.byteLength(request.url ?? '', 'utf8');
  if (urlBytes > limits.urlBytes) throw new ApiError(400, 'request_validation_failed', PUBLIC_MESSAGES.request_validation_failed, { issues: [{ path: '$.url', code: 'max_length' }] });
  const headers = request.rawHeaders ?? [];
  if (headers.length / 2 > limits.headerCount) throw new ApiError(400, 'request_validation_failed', PUBLIC_MESSAGES.request_validation_failed, { issues: [{ path: '$.headers', code: 'max_properties' }] });
  const headerBytes = headers.reduce((sum, item) => sum + Buffer.byteLength(String(item), 'utf8'), 0);
  if (headerBytes > limits.headerBytes) throw new ApiError(400, 'request_validation_failed', PUBLIC_MESSAGES.request_validation_failed, { issues: [{ path: '$.headers', code: 'max_bytes' }] });
}

function parseRequestUrl(request) {
  const raw = request.url ?? '/';
  if (/%(?![0-9A-Fa-f]{2})/.test(raw)) throw new ApiError(400, 'invalid_path_parameter');
  try {
    return new URL(raw, `http://${request.headers.host}`);
  } catch {
    throw new ApiError(400, 'invalid_path_parameter');
  }
}

function matchContract(contracts, method, pathname) {
  const pathMatches = [];
  for (const contract of contracts) {
    const match = matchPath(contract.path, pathname);
    if (match) pathMatches.push({ contract, pathParameters: match });
  }
  const exact = pathMatches.find((item) => item.contract.method === method);
  if (exact) return exact;
  if (pathMatches.length) return { methodNotAllowed: true, allow: [...new Set(pathMatches.map((item) => item.contract.method))].sort() };
  return {};
}

function matchPath(pattern, pathname) {
  const expected = pattern.split('/').filter(Boolean);
  const actual = pathname.split('/').filter(Boolean);
  if (expected.length !== actual.length) return null;
  const params = {};
  for (let index = 0; index < expected.length; index += 1) {
    const token = expected[index];
    const value = actual[index];
    if (token.startsWith('{') && token.endsWith('}')) params[token.slice(1, -1)] = value;
    else if (token !== value) return null;
  }
  return params;
}

function validatePathParameters(contract, rawParameters) {
  const output = {};
  for (const [name, schema] of Object.entries(contract.pathParameters ?? {})) {
    const raw = rawParameters[name];
    if (!raw) throw new ApiError(400, 'invalid_path_parameter');
    if (/%2f|%2F|%5c|%5C/.test(raw)) throw new ApiError(400, 'invalid_path_parameter');
    let decoded;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      throw new ApiError(400, 'invalid_path_parameter');
    }
    if (/[\u0000-\u001F\u007F\\]/u.test(decoded) || decoded === '.' || decoded === '..' || decoded.includes('../') || decoded.includes('..\\')) {
      throw new ApiError(400, 'invalid_path_parameter');
    }
    if (name === 'runId' && !SAFE_RUN_ID.test(decoded)) throw new ApiError(400, 'invalid_path_parameter');
    const result = validateJsonSchema(schema, decoded);
    if (!result.valid) throw new ApiError(400, 'invalid_path_parameter');
    output[name] = decoded;
  }
  return output;
}

function validateQuery(contract, searchParams, limits) {
  const allowed = new Set(Object.keys(contract.query?.properties ?? {}));
  const output = {};
  let count = 0;
  for (const [key, value] of searchParams.entries()) {
    count += 1;
    if (count > limits.queryParameters) throw validationError([{ path: '$.query', code: 'max_properties' }]);
    if (!allowed.has(key)) throw validationError([{ path: `$.query.${key}`, code: 'additional_properties' }]);
    if (searchParams.getAll(key).length > 1) throw validationError([{ path: `$.query.${key}`, code: 'duplicate' }]);
    if (value.length > limits.queryValueBytes) throw validationError([{ path: `$.query.${key}`, code: 'max_length' }]);
    const result = validateJsonSchema(contract.query.properties[key], value);
    if (!result.valid) throw validationError(toIssues(result.errors).map((issue) => ({ ...issue, path: `$.query.${key}` })));
    output[key] = value;
  }
  for (const required of contract.query?.required ?? []) {
    if (!searchParams.has(required)) throw validationError([{ path: `$.query.${required}`, code: 'required' }]);
  }
  return output;
}

function validateOrigin(request, contract, url) {
  const origin = request.headers.origin;
  if (!origin || contract.method === 'GET') return;
  try {
    const parsed = new URL(origin);
    const requestHost = request.headers.host;
    if (parsed.host === requestHost && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) return;
  } catch {}
  throw validationError([{ path: '$.headers.origin', code: 'origin_not_allowed' }]);
}

async function readAndValidateBody(request, contract, limits) {
  const hasLength = request.headers['content-length'] !== undefined;
  const length = hasLength ? Number(request.headers['content-length']) : 0;
  const chunked = String(request.headers['transfer-encoding'] ?? '').length > 0;
  const mayHaveBody = hasLength ? length > 0 : chunked;

  if (!contract.allowsBody) {
    if (mayHaveBody) throw validationError([{ path: '$.body', code: 'unexpected_body' }]);
    return null;
  }
  if (request.headers['content-encoding'] && String(request.headers['content-encoding']).toLowerCase() !== 'identity') {
    throw new ApiError(415, 'unsupported_content_encoding');
  }
  if (mayHaveBody) validateContentType(request.headers['content-type']);
  if (hasLength && (!Number.isFinite(length) || length > contract.maxBodyBytes || length > limits.bodyBytes)) throw new ApiError(413, 'request_too_large');
  if (!mayHaveBody && contract.bodyRequired) throw validationError([{ path: '$.body', code: 'required' }]);
  if (!mayHaveBody && !contract.bodyRequired) return {};

  const raw = await readBody(request, Math.min(contract.maxBodyBytes, limits.bodyBytes));
  if (!raw.length && contract.bodyRequired) throw validationError([{ path: '$.body', code: 'required' }]);
  if (!raw.length) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid_json');
  }
  enforceJsonComplexity(parsed, limits);
  const result = validateJsonSchema(contract.requestBodySchema, parsed);
  if (!result.valid) throw validationError(toIssues(result.errors));
  return parsed;
}

function validateContentType(value) {
  if (!value) throw new ApiError(415, 'unsupported_media_type');
  const [type, ...params] = String(value).split(';').map((part) => part.trim().toLowerCase());
  if (type !== 'application/json') throw new ApiError(415, 'unsupported_media_type');
  for (const param of params) {
    if (param.startsWith('charset=') && !['charset=utf-8', 'charset=utf8'].includes(param)) throw new ApiError(415, 'unsupported_media_type');
  }
}

async function readBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new ApiError(413, 'request_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function enforceJsonComplexity(value, limits) {
  const visit = (node, depth) => {
    if (depth > limits.jsonDepth) throw validationError([{ path: '$', code: 'max_depth' }]);
    let count = 1;
    if (Array.isArray(node)) {
      if (node.length > limits.jsonArrayItems) throw validationError([{ path: '$', code: 'max_items' }]);
      for (const item of node) count += visit(item, depth + 1);
    } else if (node && typeof node === 'object') {
      const keys = Object.keys(node);
      if (keys.length > limits.jsonObjectKeys) throw validationError([{ path: '$', code: 'max_properties' }]);
      for (const key of keys) {
        if (DANGEROUS_KEYS.has(key)) throw validationError([{ path: '$', code: 'dangerous_key' }]);
        count += visit(node[key], depth + 1);
      }
    }
    if (count > limits.jsonNodes) throw validationError([{ path: '$', code: 'max_nodes' }]);
    return count;
  };
  visit(value, 1);
}

function sendValidatedJson(response, contract, status, payload, correlationId) {
  const schema = contract.responses[status];
  if (schema) {
    try {
      assertJsonSchema(schema, payload, `${contract.operationId} response`);
    } catch (error) {
      error.code = 'response_validation_failed';
      error.operationId = contract.operationId;
      throw error;
    }
  }
  sendJson(response, status, payload, correlationId);
}

function sendJson(response, status, payload, correlationId, headers = {}) {
  response.writeHead(status, {
    ...securityHeaders(),
    ...headers,
    'x-correlation-id': correlationId,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function sendError(response, error, correlationId, { logger, started, operationId }) {
  const payload = {
    schemaVersion: '1.0.0',
    error: {
      code: error.code,
      message: PUBLIC_MESSAGES[error.code] ?? PUBLIC_MESSAGES.internal_error,
      correlationId
    }
  };
  if (error.issues?.length) payload.error.issues = error.issues.slice(0, 32);
  assertJsonSchema(API_ERROR_SCHEMA, payload, 'api error');
  safeLog(logger, error.status >= 500 ? 'error' : 'warn', { code: error.logCode ?? error.code, operationId, status: error.status, correlationId, durationMs: Date.now() - started });
  sendJson(response, error.status, payload, correlationId, error.headers);
}

function mapError(error) {
  if (error instanceof ApiError) return error;
  if (error?.code === 'response_validation_failed') {
    return new ApiError(500, 'internal_error', PUBLIC_MESSAGES.internal_error, { issues: [], headers: {}, logCode: 'response_validation_failed' });
  }
  return new ApiError(500, 'internal_error');
}

function validationError(issues) {
  return new ApiError(400, 'request_validation_failed', PUBLIC_MESSAGES.request_validation_failed, { issues });
}

function toIssues(errors) {
  return errors.map((error) => ({ path: error.path, code: String(error.keyword).replace(/[A-Z]/g, (item) => `_${item.toLowerCase()}`) }));
}

function safeLog(logger, level, entry) {
  const target = typeof logger?.[level] === 'function' ? logger[level].bind(logger) : console[level]?.bind(console) ?? console.log;
  target(entry);
}

function createUnavailableIdentityStore() {
  return {
    async isBootstrapped() { return false; },
    async recordAuditEvent() { return null; }
  };
}

export function createLoginRateLimiter({ clock = () => Date.now(), limit = 5, windowMs = 60_000, maxKeys = 2048 } = {}) {
  const buckets = new Map();
  return {
    check({ remoteAddress = 'unknown', username = '', now = clock() } = {}) {
      const key = `${remoteAddress}:${createHash('sha256').update(String(username).toLowerCase()).digest('hex')}`;
      for (const [bucketKey, bucket] of buckets) {
        if (bucket.resetAt <= now || buckets.size > maxKeys) buckets.delete(bucketKey);
      }
      const current = buckets.get(key) ?? { count: 0, resetAt: now + windowMs };
      if (current.resetAt <= now) {
        current.count = 0;
        current.resetAt = now + windowMs;
      }
      current.count += 1;
      buckets.set(key, current);
      if (current.count > limit) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
      }
      return { allowed: true, retryAfterSeconds: 0 };
    }
  };
}

function extractCredentials(request, parsed) {
  if (request.headers['x-user'] || request.headers['x-role']) return { type: 'invalid' };
  if (parsed.searchParams.has('token') || parsed.searchParams.has('access_token') || parsed.searchParams.has('api_key')) return { type: 'invalid' };
  const authorizationCount = countRawHeaders(request, 'authorization');
  if (authorizationCount > 1) return { type: 'invalid' };
  const authorization = Array.isArray(request.headers.authorization) ? request.headers.authorization.join(',') : request.headers.authorization;
  const cookies = parseCookies(request);
  if (cookies.invalid || cookies.sessionTokens.length > 1) return { type: 'invalid' };
  const sessionToken = cookies.sessionTokens[0] ?? null;
  if (authorization) {
    if (/^basic\s/i.test(authorization)) return { type: 'invalid' };
    if (!/^bearer\s+[^\s]+$/i.test(authorization)) return { type: 'invalid' };
    if (sessionToken) return { type: 'invalid' };
    return { type: 'bearer', token: authorization.replace(/^bearer\s+/i, '') };
  }
  if (sessionToken) return { type: 'session', token: sessionToken };
  return { type: 'none' };
}

function countRawHeaders(request, name) {
  const target = name.toLowerCase();
  let count = 0;
  const raw = request.rawHeaders ?? [];
  for (let index = 0; index < raw.length; index += 2) {
    if (String(raw[index]).toLowerCase() === target) count += 1;
  }
  return count;
}

function parseCookies(request) {
  const rawHeaders = request.rawHeaders ?? [];
  const cookieHeaders = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === 'cookie') cookieHeaders.push(String(rawHeaders[index + 1] ?? ''));
  }
  if (!cookieHeaders.length && request.headers.cookie) cookieHeaders.push(String(request.headers.cookie));
  const values = new Map();
  const sessionTokens = [];
  const csrfTokens = [];
  for (const header of cookieHeaders) {
    for (const item of header.split(';')) {
      const split = item.indexOf('=');
      if (split < 1) continue;
      const name = item.slice(0, split).trim();
      const value = item.slice(split + 1).trim();
      if (name === SESSION_COOKIE) sessionTokens.push(value);
      if (name === CSRF_COOKIE) csrfTokens.push(value);
      if (values.has(name) && (name === SESSION_COOKIE || name === CSRF_COOKIE)) return { invalid: true, values, sessionTokens, csrfTokens };
      values.set(name, value);
    }
  }
  return { invalid: false, values, sessionTokens, csrfTokens };
}

function resolveWorkspaceContext(contract, query, body) {
  const supported = [];
  if (query?.workspaceId) supported.push({ source: 'query', value: query.workspaceId });
  if (body?.workspaceId) supported.push({ source: 'body', value: body.workspaceId });
  if (body?.request?.workspaceId) supported.push({ source: 'contextRequest', value: body.request.workspaceId });
  const unique = [...new Set(supported.map((item) => item.value))];
  if (unique.length > 1) throw new ApiError(409, 'workspace_context_conflict');

  let selected = null;
  switch (contract.security?.workspace) {
    case 'query':
      selected = query?.workspaceId ?? null;
      break;
    case 'body':
      selected = body?.workspaceId ?? null;
      break;
    case 'contextRequest':
      selected = body?.request?.workspaceId ?? null;
      break;
    default:
      selected = unique[0] ?? null;
  }
  if (contract.security?.workspace && !selected) throw validationError([{ path: '$.workspaceId', code: 'required' }]);
  if (selected && !SAFE_WORKSPACE_ID.test(selected)) throw validationError([{ path: '$.workspaceId', code: 'pattern' }]);
  return selected;
}

function createRoutePolicyRequest({ principal, workspaceId, action, contract, correlationId, now }) {
  const membership = workspaceId
    ? principal.memberships?.find((item) => item.workspaceId === workspaceId && item.status === 'active') ?? null
    : principal.memberships?.find((item) => item.role === 'owner' && item.status === 'active') ?? null;
  const effectiveWorkspaceId = workspaceId ?? membership?.workspaceId ?? null;
  const resourceType = routeResourceType(contract);
  return {
    schemaVersion: '1.0.0',
    requestId: `polreq_${contract.operationId}`,
    correlationId,
    operationId: contract.operationId,
    principal: {
      userId: principal.user.id,
      principalType: 'user',
      authenticationMethod: principal.credentialType === 'bearer' ? 'bearer' : 'session',
      status: principal.user.status,
      tokenScopes: principal.apiToken?.scopes,
      tokenWorkspaceIds: principal.apiToken?.workspaceIds
    },
    workspaceId: effectiveWorkspaceId,
    membership: membership ? { workspaceId: membership.workspaceId, role: membership.role, status: membership.status } : null,
    action,
    resource: {
      type: resourceType,
      id: effectiveWorkspaceId ?? resourceType,
      workspaceId: effectiveWorkspaceId,
      dataClass: resourceType === 'system' ? 'public' : 'workspace-private'
    },
    environment: {
      deploymentProfile: 'local-dev',
      locality: 'local-only',
      interactive: true,
      externalWritesEnabled: false
    },
    trustedTimestamp: now
  };
}

function routeResourceType(contract) {
  switch (contract.operationId) {
    case 'getProjectStatus':
      return 'system';
    case 'createApiToken':
    case 'listApiTokens':
    case 'deleteApiToken':
      return 'token';
    case 'listRuns':
    case 'getRun':
    case 'startRun':
    case 'streamEvents':
      return 'run';
    case 'compileContext':
    case 'buildContextPack':
    case 'previewContextGraph':
      return 'context';
    case 'planHarnessSetup':
      return 'workspace';
    case 'resetBootstrap':
    case 'getDashboard':
      return 'workspace';
    default:
      return 'workspace';
  }
}

function enforceCsrf({ request, principal }) {
  const cookies = parseCookies(request);
  const cookieToken = cookies.csrfTokens[0] ?? null;
  const headerToken = Array.isArray(request.headers['x-csrf-token']) ? request.headers['x-csrf-token'][0] : request.headers['x-csrf-token'];
  if (!cookieToken || !headerToken || cookies.csrfTokens.length !== 1) throw new ApiError(403, 'csrf_failed');
  if (!timingSafeStringEqual(cookieToken, String(headerToken))) throw new ApiError(403, 'csrf_failed');
  if (!timingSafeStringEqual(hashOpaqueSecret(headerToken), principal.csrfHash)) throw new ApiError(403, 'csrf_failed');
}

function timingSafeStringEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function sessionPayload(principal) {
  const actions = [...new Set((principal.memberships ?? []).flatMap((membership) => actionsForRole(membership.role)))].sort();
  return {
    schemaVersion: '1.0.0',
    authenticated: true,
    user: principal.user,
    memberships: principal.memberships ?? [],
    actions
  };
}

function setLoginCookies(response, request, session) {
  const secure = secureCookieAttribute(request);
  response.setHeader('set-cookie', [
    `${SESSION_COOKIE}=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}`,
    `${CSRF_COOKIE}=${session.csrfToken}; SameSite=Strict; Path=/; Max-Age=604800${secure}`
  ]);
}

function setLogoutCookies(response, request) {
  const secure = secureCookieAttribute(request);
  response.setHeader('set-cookie', [
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`,
    `${CSRF_COOKIE}=; SameSite=Strict; Path=/; Max-Age=0${secure}`
  ]);
}

function secureCookieAttribute(request) {
  const host = request.headers.host ?? '';
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  const loopback = LOOPBACK_HOSTS.has(hostname);
  const proto = String(request.headers['x-forwarded-proto'] ?? 'http').toLowerCase();
  if (!loopback && proto !== 'https') throw new ApiError(401, 'invalid_authentication', PUBLIC_MESSAGES.invalid_authentication, { headers: { 'www-authenticate': 'Bearer' } });
  return proto === 'https' ? '; Secure' : '';
}

async function serveStatic(response, rawPathname) {
  const url = new URL(rawPathname, 'http://127.0.0.1');
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
  const target = path.resolve(webRoot, relative);
  if (!target.startsWith(`${webRoot}${path.sep}`) && target !== path.join(webRoot, 'index.html')) throw new ApiError(403, 'request_validation_failed');
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not file');
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
    const content = await readFile(target);
    response.writeHead(200, { ...securityHeaders(), 'content-type': types[path.extname(target)] ?? 'application/octet-stream', 'cache-control': path.extname(target) === '.html' ? 'no-cache' : 'public, max-age=300' });
    response.end(content);
  } catch {
    const fallback = await readFile(path.join(webRoot, 'index.html'));
    response.writeHead(200, { ...securityHeaders(), 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    response.end(fallback);
  }
}

function normalizeHarnesses(value) {
  const aliases = new Map([['claude', 'claude-code']]);
  return String(value ?? 'all').split(',').map((item) => aliases.get(item.trim()) ?? item.trim()).filter(Boolean);
}

function securityHeaders() {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'cross-origin-opener-policy': 'same-origin',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  };
}

async function main() {
  const host = process.env.OAF_HOST ?? '127.0.0.1';
  const port = Number(process.env.OAF_PORT ?? 4310);
  const dataDir = process.env.OAF_DATA_DIR ?? '.local';
  const store = await new FileStateStore(dataDir).init();
  const identityStore = await new LocalIdentityStore({ directory: path.join(dataDir, 'identity') }).init();
  const manifestRepository = new FilesystemContextManifestRepository({ root: path.join(dataDir, 'context-manifests') });
  const api = createControlApiServer({ store, identityStore, manifestRepository });
  api.server.listen(port, host, () => {
    console.log(`Open Agent Fabric local bootstrap: http://${host}:${port}`);
    console.log('No external writes are enabled. Press Ctrl+C to stop.');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      api.close(() => process.exit(0));
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
