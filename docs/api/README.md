# API

`openapi.yaml` documents only the implemented local bootstrap routes. OAF-008 adds native local authentication and workspace authorization. This does not imply production SSO, MFA, durable workflow orchestration, publishing, or external adapters. Protocol JSON Schemas under `packages/protocol/schemas/` are the canonical domain contracts.

## Runtime boundary

The runtime source of truth is `services/control-api/src/route-contracts.mjs`. Every implemented `/api/*` route declares method, path pattern, operation ID, path/query/header expectations, request media type, body schema, body-size limit, response schemas, body allowance, and streaming behavior. Tests compare this registry with `openapi.yaml` so documentation and runtime routes do not drift.

Implemented routes:

- `GET /api/health`
- `GET /api/auth/bootstrap-status`
- `POST /api/auth/bootstrap`
- `POST /api/auth/login`
- `GET /api/auth/session`
- `POST /api/auth/logout`
- `POST /api/auth/tokens`
- `GET /api/auth/tokens`
- `DELETE /api/auth/tokens/{tokenId}`
- `GET /api/status`
- `GET /api/dashboard`
- `GET /api/runs`
- `POST /api/runs`
- `GET /api/runs/{runId}`
- `POST /api/context/compile`
- `POST /api/context/pack`
- `POST /api/context/graph/preview`
- `POST /api/reset`
- `GET /api/stream`

## Request limits

The control API applies a configurable global ceiling plus per-route limits before domain handlers run. The default global body ceiling is 1 MB; `POST /api/runs` is capped more tightly, `POST /api/context/compile` is capped for bounded local context payloads, and `POST /api/context/graph/preview` only accepts bounded search/trace/impact selectors. The source-graph preview route uses the server-configured workspace root; callers cannot submit arbitrary filesystem roots. The boundary also limits URL bytes, path segment length, query parameter count, query value length, header count/bytes, JSON nesting depth, total JSON node count, object key count, and array item count.

Both `Content-Length` and streamed byte count are checked. Chunked requests cannot exceed the same route limit.

## Media and encoding

JSON routes accept `application/json` with optional UTF-8 charset. Unsupported media types, unsupported charsets, and compressed request bodies such as gzip, deflate, or Brotli receive stable 415 errors. The bootstrap API does not decompress request bodies.

Routes that do not allow bodies reject unexpected non-empty bodies. Required-body routes reject missing or empty bodies.

## Correlation IDs

Every API request receives an internal `req_...` correlation ID. A caller may supply `x-correlation-id` only when it matches the strict bounded pattern; invalid supplied values are discarded and never reflected. The accepted/generated ID is returned in the `x-correlation-id` response header, included in every JSON error envelope, and added to API-triggered workflow events where the current event contract permits.

Correlation IDs are observability handles only. They are not authentication or authorization.

## Stable errors and redaction

JSON API errors use:

```json
{
  "schemaVersion": "1.0.0",
  "error": {
    "code": "request_validation_failed",
    "message": "The request did not match the API contract.",
    "correlationId": "req_...",
    "issues": [{ "path": "$.objective", "code": "max_length" }]
  }
}
```

Stable codes include `invalid_json`, `request_validation_failed`, `invalid_path_parameter`, `route_not_found`, `method_not_allowed`, `request_too_large`, `unsupported_media_type`, `unsupported_content_encoding`, and `internal_error`.
OAF-008 adds `authentication_required`, `invalid_credentials`, `invalid_authentication`, `csrf_failed`, `forbidden`, `resource_not_found`, `already_bootstrapped`, `workspace_context_conflict`, `rate_limited`, and `bootstrap_required`. Authentication errors include `WWW-Authenticate`.

Public errors never include stack traces, SQL, filesystem paths, environment variables, headers, raw request bodies, tokens, cookies, authorization values, or submitted values. Structured logs contain safe status, operation ID, error code, duration, and correlation ID.

## Host and origin

The local bootstrap accepts loopback hosts by default: `127.0.0.1`, `localhost`, and `[::1]`. State-changing API requests with an `Origin` header must match the local application origin. CLI-style local requests that omit `Origin` remain accepted. The API does not add wildcard CORS.

Authentication follows boundary validation. Cookie-auth unsafe requests also require CSRF; bearer API tokens are exempt from CSRF but cannot create or manage API tokens.

## Response validation

JSON handler responses are validated against their registered response schemas before sending. If a handler creates an invalid response, the API fails closed with a sanitized `internal_error`. SSE chunks are not JSON-response validated, but `/api/stream` still receives security headers, no-store caching, correlation headers, bounded connection bookkeeping, and disconnect cleanup.

## Adding a route

Add the route to `services/control-api/src/route-contracts.mjs` first, then implement the handler in the control API factory. Add request and response schemas, compatibility examples when the protocol surface changes, OpenAPI documentation, and adversarial tests proving invalid requests do not invoke domain handlers.
