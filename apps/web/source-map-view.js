import { escapeHtml, formatDate, renderApiErrorPanel, statePanel } from './ui-primitives.js';
import { createGraphViewport } from './graph-viewport.js';

const DEFAULT_DEPTH = 2;
const DEFAULT_LIMIT = 20;

export function parseMapUrl(input = '/map') {
  const url = new URL(String(input || '/map'), 'http://127.0.0.1');
  const query = boundedText(url.searchParams.get('query'), 512);
  const group = boundedText(url.searchParams.get('group'), 512);
  const startName = boundedText(url.searchParams.get('start'), 240);
  const changedLocator = boundedText(url.searchParams.get('changed'), 512);
  const depth = boundedInteger(url.searchParams.get('depth'), DEFAULT_DEPTH, 1, 5);
  const limit = boundedInteger(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, 100);
  return {
    query,
    group,
    startName,
    changedLocator,
    depth,
    limit,
    advanced: Boolean(startName || changedLocator || depth !== DEFAULT_DEPTH || limit !== DEFAULT_LIMIT)
  };
}

export function serializeMapUrl(value = {}) {
  const state = normalizeMapState(value);
  const params = new URLSearchParams();
  if (state.query) params.set('query', state.query);
  if (state.group) params.set('group', state.group);
  if (state.startName) params.set('start', state.startName);
  if (state.changedLocator) params.set('changed', state.changedLocator);
  if (state.depth !== DEFAULT_DEPTH) params.set('depth', String(state.depth));
  if (state.limit !== DEFAULT_LIMIT) params.set('limit', String(state.limit));
  const query = params.toString();
  return query ? `/map?${query}` : '/map';
}

export function buildMapRequest(value = {}) {
  const state = normalizeMapState(value);
  return compactObject({
    query: state.query || null,
    locatorPrefix: state.group || null,
    startName: state.startName || null,
    changedLocators: state.changedLocator ? [state.changedLocator] : null,
    depth: state.depth,
    limit: state.limit,
    sampleLimit: 50
  });
}

export function mapStateFromForm(form) {
  const data = new FormData(form);
  return normalizeMapState({
    query: data.get('query'),
    group: data.get('group'),
    startName: data.get('startName'),
    changedLocator: data.get('changedLocator'),
    depth: data.get('depth'),
    limit: data.get('limit')
  });
}

export function renderSourceMap({ state: value = {}, report = null, error = null, loading = false } = {}) {
  const state = normalizeMapState(value);
  const result = error
    ? renderApiErrorPanel('Map request failed', error)
    : loading
      ? statePanel('loading', 'Reading repository map', 'Loading bounded source metadata from the local API.')
      : report
        ? renderMapResult(report, state)
        : statePanel('empty', 'Map not loaded', 'Run the map to inspect bounded repository structure.');

  return `<div class="tool-workspace source-map-workspace">
    <header class="tool-page-heading map-page-heading"><div><h1>Map</h1><p>Find an entry point, trace a symbol, or inspect a changed file.</p></div><span>Read-only / bounded metadata</span></header>
    ${renderMapForm(state)}
    ${result}
  </div>`;
}

export function bindSourceMap(root, { report = null, onSubmit, onRefresh, onSelectNode } = {}) {
  if (!root) return () => {};
  const controller = new AbortController();
  const options = { signal: controller.signal };
  let viewport = null;
  root.querySelector('#source-graph-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    onSubmit?.(mapStateFromForm(event.currentTarget), event);
  }, options);
  root.querySelector('[data-action="refresh-source-map"]')?.addEventListener('click', (event) => onRefresh?.(event), options);
  const canvas = root.querySelector('#source-map-canvas');
  if (canvas) {
    const nodes = arrayValue(report?.focus?.nodes);
    viewport = createGraphViewport(
      canvas,
      root.querySelector('.source-map-outline'),
      root.querySelector('#source-map-selection'),
      {
        nodes,
        edges: arrayValue(report?.focus?.edges),
        onSelect: (node) => {
          const selection = root.querySelector('#source-map-selection');
          if (selection) selection.innerHTML = renderSelection(node);
          onSelectNode?.(node.id);
        },
        onError: (code) => {
          const failure = root.querySelector('[data-graph-error]');
          if (failure) {
            failure.hidden = false;
            failure.textContent = code === 'graph_layout_bounds_exceeded'
              ? 'Focused graph exceeds the 200-node or 400-relationship display limit.'
              : 'Graph layout could not start. Use the outline to inspect records.';
          }
        }
      }
    );
  } else {
    root.querySelectorAll('[data-node-id]').forEach((button) => button.addEventListener('click', () => onSelectNode?.(button.dataset.nodeId), options));
  }
  return () => {
    controller.abort();
    viewport?.destroy();
  };
}

function renderMapForm(state) {
  return `<section class="tool-query map-query"><form id="source-graph-form" class="source-map-form">
    <label class="field"><span>Query</span><input name="query" value="${escapeHtml(state.query)}" placeholder="File, symbol, or concept" maxlength="512"></label>
    <details class="map-advanced"${state.advanced ? ' open' : ''}>
      <summary>Scope and trace</summary>
      <div class="map-advanced-fields">
        <label class="field"><span>Group</span><input name="group" value="${escapeHtml(state.group)}" placeholder="apps/web" maxlength="512"></label>
        <label class="field"><span>Trace symbol</span><input name="startName" value="${escapeHtml(state.startName)}" placeholder="execute" maxlength="240"></label>
        <label class="field"><span>Changed locator</span><input name="changedLocator" value="${escapeHtml(state.changedLocator)}" placeholder="src/trade.ts" maxlength="512"></label>
        <label class="field field-compact"><span>Depth</span><input name="depth" type="number" min="1" max="5" value="${state.depth}"></label>
        <label class="field field-compact"><span>Limit</span><input name="limit" type="number" min="1" max="100" value="${state.limit}"></label>
      </div>
    </details>
    <div class="map-query-actions"><button class="button primary" type="submit">Run map</button><button class="button quiet" type="button" data-action="refresh-source-map">Refresh scan</button><span>No model, network, or external writes</span></div>
  </form></section>`;
}

function renderMapResult(report, state) {
  const coverage = coverageModel(report);
  const hasFocus = Boolean(state.query || state.group || state.startName || state.changedLocator);
  const focusNodes = arrayValue(report.focus?.nodes);
  const focusEdges = arrayValue(report.focus?.edges);
  const groups = arrayValue(report.orientation?.groups);
  const outlineNodes = hasFocus ? focusNodes : groups;
  const content = hasFocus
    ? renderFocus(focusNodes, focusEdges, report.focus)
    : renderGroups(groups, arrayValue(report.orientation?.relations ?? report.orientation?.groupRelations));

  return `<section class="source-map-result" aria-labelledby="map-result-title">
    <header class="map-result-heading"><div><h2 id="map-result-title">${hasFocus ? 'Focused map' : 'Repository groups'}</h2><p>${escapeHtml(coverage.summary)}</p></div>${snapshotLabel(report.snapshot)}</header>
    ${coverage.status === 'partial' ? renderCoverageWarning(coverage) : ''}
    <div class="source-map-layout">
      <section class="source-map-stage" aria-label="${hasFocus ? 'Focused source relationships' : 'Repository group relationships'}">${content}</section>
      <aside class="source-map-inspector"><h2>Selection</h2><div id="source-map-selection">${renderSelection(outlineNodes[0])}</div><hr><h2>Source map outline</h2>${renderMapOutline(outlineNodes, hasFocus)}<hr>${renderSourceTruth(report, coverage)}</aside>
    </div>
  </section>`;
}

function renderGroups(groups, relations) {
  if (!groups.length) return statePanel('empty', 'No supported groups', 'No JavaScript or TypeScript groups were represented inside the current scan bounds.');
  const byId = new Map(groups.map((group) => [group.id, group]));
  return `<div class="map-groups">${groups.map((group) => `<article><strong>${escapeHtml(group.prefix ?? group.label)}</strong><span>${number(group.fileCount)} files / ${number(group.symbolCount)} symbols</span>${group.changedFileCount ? `<small>${number(group.changedFileCount)} changed</small>` : ''}</article>`).join('')}</div>${relations.length ? `<ol class="map-relations" aria-label="Group relationships">${relations.map((relation) => {
    const source = byId.get(relation.sourceGroupId);
    const target = byId.get(relation.targetGroupId);
    return source && target ? `<li><strong>${escapeHtml(source.prefix)}</strong><span>to</span><strong>${escapeHtml(target.prefix)}</strong><small>${number(relation.count)} relationships</small></li>` : '';
  }).join('')}</ol>` : '<p class="muted">No cross-group relationships inside the current bounds.</p>'}`;
}

function renderFocus(nodes, edges, focus = {}) {
  if (!nodes.length) return statePanel('empty', 'No focused records', 'The submitted scope produced no bounded nodes. Broaden the query or remove a group filter.');
  return `<div class="map-graph-toolbar"><div class="map-focus-summary"><strong>${number(nodes.length)} nodes</strong><span>${number(edges.length)} relationships</span>${number(focus.omittedNodes ?? focus.omittedNodeCount) ? `<span>${number(focus.omittedNodes ?? focus.omittedNodeCount)} nodes omitted</span>` : ''}${number(focus.omittedEdges ?? focus.omittedEdgeCount) ? `<span>${number(focus.omittedEdges ?? focus.omittedEdgeCount)} relationships omitted</span>` : ''}</div><div><button class="button secondary" type="button" data-graph-action="fit">Fit selection</button><button class="button quiet" type="button" data-graph-action="reset">Reset view</button></div></div><p class="map-graph-error" data-graph-error hidden></p><div class="source-map-canvas-wrap"><canvas id="source-map-canvas" width="960" height="560" role="img" aria-label="Interactive focused source graph"></canvas></div>`;
}

function renderMapOutline(items, focused) {
  if (!items.length) return '<p>No records in the current outline.</p>';
  return `<ol class="source-map-outline" aria-label="Source map outline">${items.map((item, index) => `<li><button type="button" data-node-id="${escapeHtml(item.id)}"${index === 0 ? ' aria-current="true"' : ''}><strong>${escapeHtml(focused ? item.label : item.prefix ?? item.label)}</strong><span>${escapeHtml(focused ? item.locator ?? item.kind : `${number(item.fileCount)} files`)}</span></button></li>`).join('')}</ol>`;
}

function renderSelection(item) {
  if (!item) return '<p>No selection.</p>';
  return `<dl class="facts compact-facts"><div><dt>Name</dt><dd>${escapeHtml(item.label ?? item.prefix)}</dd></div><div><dt>Type</dt><dd>${escapeHtml(item.kind ?? 'repository group')}</dd></div>${item.locator ? `<div><dt>Locator</dt><dd><code>${escapeHtml(item.locator)}</code></dd></div>` : ''}</dl>`;
}

function renderSourceTruth(report, coverage) {
  const safeguards = report.safeguards ?? {};
  return `<div class="source-map-truth"><h2>Scan truth</h2><dl class="facts compact-facts"><div><dt>Coverage</dt><dd>${escapeHtml(coverage.status)}</dd></div><div><dt>Represented</dt><dd>${number(coverage.representedFiles)} files</dd></div><div><dt>Model calls</dt><dd>${number(safeguards.modelCalls)}</dd></div><div><dt>Network calls</dt><dd>${number(safeguards.networkCalls)}</dd></div><div><dt>External writes</dt><dd>${safeguards.externalWritesEnabled ? 'on' : 'off'}</dd></div></dl></div>`;
}

function renderCoverageWarning(coverage) {
  const reasons = coverage.reasonCodes.map(reasonLabel);
  return `<section class="map-coverage-warning" aria-label="Partial map coverage"><strong>Partial coverage</strong><p>${escapeHtml(coverage.summary)}</p>${reasons.length ? `<ul>${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>` : ''}</section>`;
}

function coverageModel(report) {
  const source = report.coverage ?? report.graph?.summary?.coverage ?? {};
  const representedFiles = number(source.representedFileCount ?? report.graph?.summary?.fileCount);
  const omittedFiles = number(source.omittedFileCount ?? (
    number(source.skippedFileCount) + number(source.oversizedFileCount) + number(source.unsupportedFileCount)
  ));
  const omittedEdges = number(source.omittedEdgeCount);
  const status = source.status === 'partial' ? 'partial' : 'complete';
  const parts = [`${formatNumber(representedFiles)} represented files`];
  if (omittedFiles) parts.push(`${formatNumber(omittedFiles)} omitted files`);
  if (omittedEdges) parts.push(`${formatNumber(omittedEdges)} omitted relationships`);
  return { status, representedFiles, omittedFiles, omittedEdges, reasonCodes: arrayValue(source.reasonCodes), summary: parts.join(' / ') };
}

function snapshotLabel(snapshot = {}) {
  const status = escapeHtml(snapshot.status ?? 'unavailable');
  const reuse = snapshot.reuse && snapshot.reuse !== 'none' ? ` / ${escapeHtml(snapshot.reuse)}` : '';
  const built = snapshot.builtAt ? ` / ${escapeHtml(formatDate(snapshot.builtAt))}` : '';
  return `<span class="map-snapshot">${status}${reuse}${built}</span>`;
}

function reasonLabel(value) {
  const labels = {
    file_budget_reached: 'File limit reached',
    max_files_reached: 'File limit reached',
    node_budget_reached: 'Node limit reached',
    edge_budget_reached: 'Relationship limit reached'
  };
  return labels[value] ?? String(value ?? '').replaceAll('_', ' ');
}

function normalizeMapState(value) {
  const query = boundedText(value.query, 512);
  const group = boundedText(value.group, 512);
  const startName = boundedText(value.startName, 240);
  const changedLocator = boundedText(value.changedLocator, 512);
  const depth = boundedInteger(value.depth, DEFAULT_DEPTH, 1, 5);
  const limit = boundedInteger(value.limit, DEFAULT_LIMIT, 1, 100);
  return {
    query, group, startName, changedLocator, depth, limit,
    advanced: Boolean(startName || changedLocator || depth !== DEFAULT_DEPTH || limit !== DEFAULT_LIMIT)
  };
}

function boundedText(value, maximum) {
  return String(value ?? '').trim().slice(0, maximum);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const candidate = Number(value);
  return Number.isInteger(candidate) && candidate >= minimum && candidate <= maximum ? candidate : fallback;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== ''));
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function number(value) {
  const candidate = Number(value);
  return Number.isFinite(candidate) && candidate >= 0 ? Math.floor(candidate) : 0;
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(number(value));
}
