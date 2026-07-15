const API_ISSUE_HINTS = new Map([
  ['$.body.changedLocators', ['Changed files', 'Use workspace-relative paths under this repository, one per line. Keep the list bounded and review it before building.']],
  ['$.body.userSelectedFiles', ['Explicit files', 'Use workspace-relative paths under this repository. Do not paste file bodies, absolute paths, credentials, or provider URLs.']],
  ['$.body.memoryConfig.memoryPaths', ['Memory preflight sources', 'Use reviewed workspace-relative files only. Do not use absolute paths, URLs, credentials, or generated/local state directories.']],
  ['$.body.client', ['Client', 'Choose a supported local harness client from the menu.']],
  ['$.body.objective', ['Objective', 'Use a plain task summary. Do not include secrets, provider URLs, session tokens, absolute paths, or hidden reasoning.']],
  ['$.body.step', ['Step', 'Use a short current-step label. Do not include secrets, provider URLs, session tokens, absolute paths, or hidden reasoning.']],
  ['$.body.tokenBudget', ['Token budget', 'Use a positive number within the field limit.']],
  ['$.body.sourceLocator', ['Source locator', 'Use a workspace-relative source file such as notes/memory.md.']],
  ['$.body.text', ['Memory text', 'Use simple Fact or Decision lines with safe subject, predicate, and object text.']],
  ['$.body.targetHarness', ['Target', 'Choose Codex, Claude Code, Cursor, or Generic agent.']],
  ['$.body.from', ['Source families', 'Use supported source families only, such as codex, cursor, or claude-code.']],
  ['$.body.workspaceId', ['Workspace', 'Use the current local workspace.']]
]);

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

export function formatDate(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '-';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
}

export function shortFingerprint(value) {
  return `${String(value ?? '').slice(0, 19)}...`;
}

export function titleize(value) {
  return String(value ?? '').split(/[-_]/u).filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ') || 'Step';
}

export function safeErrorToken(value, fallback, maxLength = 120) {
  const text = String(value ?? '').trim();
  if (!text || containsPrivateValue(text)) return fallback;
  const normalized = text.replace(/[^\w$.[\]:-]/gu, '_').slice(0, maxLength);
  return containsPrivateValue(normalized) ? fallback : normalized;
}

export function buildApiErrorUiModel(errorLike) {
  const error = typeof errorLike === 'object' && errorLike ? errorLike : { message: String(errorLike ?? 'Request failed.') };
  const issues = Array.isArray(error.issues) ? error.issues.slice(0, 5).map((issue) => {
    const path = safeErrorToken(issue?.path, '$.body');
    const code = safeErrorToken(issue?.code, 'validation_failed', 64);
    return { path, code, ...apiIssueHint(path) };
  }) : [];
  return {
    message: String(error.message ?? 'Request failed.'),
    status: Number.isFinite(Number(error.status)) ? Number(error.status) : null,
    code: safeErrorToken(error.code, '', 64),
    correlationId: safeErrorToken(error.correlationId, '', 96),
    issues
  };
}

export function renderApiErrorPanel(heading, error) {
  const model = buildApiErrorUiModel(error);
  return statePanel('error', heading, model.message, false, renderApiErrorRecovery(model));
}

export function renderApiErrorRecovery(model) {
  const issues = model.issues.length
    ? `<div class="issue-recovery"><h3>Fix this field</h3><ul>${model.issues.map((issue) => `<li><strong>${escapeHtml(issue.label)}</strong><span>${escapeHtml(issue.detail)}</span><code>${escapeHtml(issue.path)} · ${escapeHtml(issue.code)}</code></li>`).join('')}</ul></div>`
    : '';
  const correlation = model.correlationId
    ? `<p class="error-correlation">Correlation <code>${escapeHtml(model.correlationId)}</code></p>`
    : '';
  return `${issues}${correlation}`;
}

export function statePanel(kind, heading, copy, button = false, extra = '') {
  const actions = button
    ? '<div class="action-row"><button class="button primary" data-action="run" type="button">Run local demo</button><button class="button secondary" data-action="reset" type="button">Reset demo</button></div>'
    : '';
  return `<section class="state-panel state-${escapeHtml(kind)}" aria-live="${kind === 'loading' ? 'polite' : 'off'}"><h2>${escapeHtml(heading)}</h2><p>${escapeHtml(copy)}</p>${extra}${actions}</section>`;
}

function apiIssueHint(path) {
  const direct = API_ISSUE_HINTS.get(path);
  if (direct) return { label: direct[0], detail: direct[1] };
  if (path.startsWith('$.body.')) return { label: titleize(path.slice('$.body.'.length)), detail: 'Review this field and use only supported local values.' };
  return { label: 'Request field', detail: 'Review the highlighted request field and retry with supported local values.' };
}

function containsPrivateValue(value) {
  return /(?:\/Users|\/private|\/var\/folders|https?:|file:|token|secret|api[_-]?key|authorization|cookie)/iu.test(value);
}
