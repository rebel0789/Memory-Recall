// This exact pattern is asserted against both source-graph JSON schemas.
// Keep it narrowly scoped to portable workspace-relative source graph locators.
export const SOURCE_GRAPH_WORKSPACE_ID_PATTERN = String.raw`^[a-z][a-z0-9_-]{0,127}$`;
export const SOURCE_GRAPH_FINGERPRINT_PATTERN = String.raw`^sha256:[a-f0-9]{64}$`;
export const SOURCE_GRAPH_WORKSPACE_LOCATOR_PATTERN = String.raw`^workspace://(?!/)(?![^/]*%)(?![A-Za-z][A-Za-z0-9+.-]*:)(?!\.\.(?:/|$))(?!.*\/\.\.(?:/|$))(?!.*%(?:2[eEfF]|3[aA]|5[cC]|25))[A-Za-z0-9._~!$&'()*+,;=@%/\[\]-]{1,512}(?:#L[0-9]+-L[0-9]+)?$`;
export const SOURCE_GRAPH_WORKSPACE_ID_RE = new RegExp(SOURCE_GRAPH_WORKSPACE_ID_PATTERN, 'u');
export const SOURCE_GRAPH_FINGERPRINT_RE = new RegExp(SOURCE_GRAPH_FINGERPRINT_PATTERN, 'u');
export const SOURCE_GRAPH_WORKSPACE_LOCATOR_RE = new RegExp(SOURCE_GRAPH_WORKSPACE_LOCATOR_PATTERN, 'u');
const SOURCE_GRAPH_ENCODED_PATH_ESCAPE_RE = /%(?:2[eEfF]|3[aA]|5[cC]|25)/u;
const SOURCE_GRAPH_DECODED_PATH_ESCAPE_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)|\\/u;
const SOURCE_GRAPH_URI_SCHEME_TOKEN_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const SOURCE_GRAPH_MAX_PERCENT_DECODE_PASSES = 4;

export function normalizeSourceGraphWorkspaceLocator(value, { stripFragment = false } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const relative = raw.startsWith('workspace://') ? null : raw.replace(/^\.\//u, '');
  if (relative !== null && sourceGraphLocatorHasUriScheme(relative)) throw new Error('source_graph_workspace_locator_invalid');
  const locator = raw.startsWith('workspace://')
    ? raw
    : `workspace://${relative}`;
  if (sourceGraphLocatorHasUnsafeEncodedPath(locator) || !SOURCE_GRAPH_WORKSPACE_LOCATOR_RE.test(locator)) throw new Error('source_graph_workspace_locator_invalid');
  return stripFragment ? locator.split('#', 1)[0] : locator;
}

function sourceGraphLocatorHasUnsafeEncodedPath(locator) {
  let current = String(locator ?? '');
  for (let pass = 0; pass < SOURCE_GRAPH_MAX_PERCENT_DECODE_PASSES; pass += 1) {
    if (SOURCE_GRAPH_ENCODED_PATH_ESCAPE_RE.test(current) || sourceGraphLocatorHasUriScheme(current)) return true;
    let decoded;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return true;
    }
    if (decoded === current) return false;
    if (SOURCE_GRAPH_DECODED_PATH_ESCAPE_RE.test(decoded) || sourceGraphLocatorHasUriScheme(decoded)) return true;
    current = decoded;
  }
  return current.includes('%');
}

function sourceGraphLocatorHasUriScheme(value) {
  const relative = String(value ?? '').replace(/^workspace:\/\//u, '').split('#', 1)[0];
  return relative.split('/').some((segment) => SOURCE_GRAPH_URI_SCHEME_TOKEN_RE.test(segment));
}

// This exact pattern is asserted against both source-graph JSON schemas.
// It allows static symbol, module, file, chunk, and bounded edge labels only.
export const SOURCE_GRAPH_SAFE_LABEL_TOKEN_PATTERN = String.raw`[A-Za-z0-9_$@~./#*+,\[\]-]+`;
const SOURCE_GRAPH_SAFE_NODE_MODULE_PATTERN = String.raw`[A-Za-z0-9_][A-Za-z0-9_.-]*(?:/[A-Za-z0-9_][A-Za-z0-9_.-]*)*`;
const SOURCE_GRAPH_SAFE_LABEL_VALUE_PATTERN = String.raw`(?:${SOURCE_GRAPH_SAFE_LABEL_TOKEN_PATTERN}|node:${SOURCE_GRAPH_SAFE_NODE_MODULE_PATTERN}|local:absolute-import)`;
export const SOURCE_GRAPH_SAFE_LABEL_PATTERN = String.raw`^(?=.{1,240}$)(?!/)(?![A-Za-z]:[\\/])(?!.*[?{}=;\\])(?!.*[Ss][Ee][Nn][Tt][Ii][Nn][Ee][Ll])${SOURCE_GRAPH_SAFE_LABEL_VALUE_PATTERN}(?: (?:contains|defined_in|imports|exports|references|calls)(?: ${SOURCE_GRAPH_SAFE_LABEL_VALUE_PATTERN}){1,2})?$`;
export const SOURCE_GRAPH_SAFE_LABEL_RE = new RegExp(SOURCE_GRAPH_SAFE_LABEL_PATTERN, 'u');

export function isSafeSourceGraphDisplayLabel(value) {
  return typeof value === 'string' && SOURCE_GRAPH_SAFE_LABEL_RE.test(value);
}
