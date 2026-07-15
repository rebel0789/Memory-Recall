import { createGraphViewport } from './graph-viewport.js';
import { escapeHtml, formatDate, renderApiErrorPanel, statePanel } from './ui-primitives.js';

export function buildMemoryGraphViewModel(report = null, options = {}, error = null) {
  const sourceNodes = arrayValue(report?.graph?.nodes);
  const sourceEdges = arrayValue(report?.graph?.edges);
  const history = options.history === true;
  const query = String(options.query ?? '').trim().slice(0, 512);
  const groupRelated = options.communities === true;
  const currentNodes = history ? sourceNodes : sourceNodes.filter(({ current }) => current !== false);
  const currentEdges = history ? sourceEdges : sourceEdges.filter(({ current }) => current !== false);
  const focusIds = new Set(arrayValue(report?.focus?.nodes).flatMap((node) => [node.id, node.name]).filter(Boolean));
  const focusedNodes = focusIds.size ? currentNodes.filter((node) => focusIds.has(node.id) || focusIds.has(node.name)) : currentNodes;
  const { nodes, edges } = filterMemoryGraph(focusedNodes, currentEdges, query);
  const orderedNodes = groupRelated
    ? [...nodes].sort((left, right) => nonNegativeInteger(left.community) - nonNegativeInteger(right.community) || String(left.name ?? left.id).localeCompare(String(right.name ?? right.id)))
    : nodes;
  const boundedNodes = orderedNodes.length > 200
    ? [...orderedNodes].sort((left, right) => nonNegativeInteger(right.degree) - nonNegativeInteger(left.degree) || String(left.id).localeCompare(String(right.id))).slice(0, 200)
    : orderedNodes;
  const boundedEdges = edges.length > 400
    ? [...edges].sort((left, right) => Number(right.current !== false) - Number(left.current !== false) || String(left.id).localeCompare(String(right.id))).slice(0, 400)
    : edges;
  const nodeIds = new Set(boundedNodes.map(({ id }) => id));
  const viewportEdges = boundedEdges
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .map((edge) => ({ ...edge, fromNodeId: edge.from, toNodeId: edge.to, kind: edge.predicate }));
  const summary = {
    nodeCount: sourceNodes.length,
    edgeCount: sourceEdges.length,
    currentNodeCount: sourceNodes.filter(({ current }) => current !== false).length,
    currentEdgeCount: sourceEdges.filter(({ current }) => current !== false).length,
    historyNodeCount: sourceNodes.filter(({ current }) => current === false).length,
    historyEdgeCount: sourceEdges.filter(({ current }) => current === false).length,
    ...(report?.summary ?? {})
  };
  return Object.freeze({
    ready: Boolean(report?.graph),
    error,
    workspaceId: report?.workspaceId ?? 'ws_local',
    provider: report?.provider ?? 'provider:native:memory:sqlite',
    generatedAt: report?.generatedAt ?? null,
    reportFingerprint: report?.reportFingerprint ?? null,
    safeguards: report?.safeguards ?? {},
    summary,
    query,
    history,
    groupRelated,
    nodes: Object.freeze(boundedNodes.map((node) => Object.freeze({ ...node, label: node.name ?? node.id }))),
    edges: Object.freeze(boundedEdges),
    viewportEdges: Object.freeze(viewportEdges),
    omittedNodeCount: Math.max(0, orderedNodes.length - boundedNodes.length),
    omittedEdgeCount: Math.max(0, edges.length - boundedEdges.length),
    sourceNodeCount: sourceNodes.length,
    sourceEdgeCount: sourceEdges.length
  });
}

export function renderMemoryGraphView(model) {
  if (model.error) return `<div class="tool-workspace memory-graph-workbench">${memoryGraphHeading()}${renderApiErrorPanel('Memory graph unavailable', model.error)}</div>`;
  if (!model.ready) return `<div class="tool-workspace memory-graph-workbench">${memoryGraphHeading()}${statePanel('empty', 'Memory graph not loaded', 'The local memory provider did not return a graph report.')}</div>`;

  const controls = renderMemoryGraphControls(model);
  if (model.sourceNodeCount === 0) {
    return `<div class="tool-workspace memory-graph-workbench">${memoryGraphHeading()}${controls}<section class="memory-graph-empty"><h2>No governed memory yet</h2><p>Checked workspace <code>${escapeHtml(model.workspaceId)}</code> through <code>${escapeHtml(model.provider)}</code>. No approved temporal facts are available.</p><p>Review or add a source-backed proposal on the Memory route, then refresh this view.</p>${memoryGraphBoundary(model)}</section></div>`;
  }
  if (model.nodes.length === 0) {
    return `<div class="tool-workspace memory-graph-workbench">${memoryGraphHeading()}${controls}${statePanel('empty', 'No matching memory', 'No governed facts match the current search and history scope.')}${memoryGraphBoundary(model)}</div>`;
  }

  const first = model.nodes[0];
  return `<div class="tool-workspace memory-graph-workbench">
    ${memoryGraphHeading()}
    ${controls}
    <section class="memory-graph-layout" aria-labelledby="governed-graph-title">
      <div class="memory-graph-stage">
        <header class="memory-graph-stage-heading"><div><h2 id="governed-graph-title">Governed facts</h2><p>${model.nodes.length} visible records / ${model.edges.length} visible relationships${model.omittedNodeCount || model.omittedEdgeCount ? ` / ${model.omittedNodeCount} records and ${model.omittedEdgeCount} relationships omitted by display bounds` : ''}</p></div><div><button class="button secondary" type="button" data-memory-graph-action="fit">Fit selection</button><button class="button secondary" type="button" data-memory-graph-action="reset">Reset view</button></div></header>
        <p class="map-graph-error" data-memory-graph-error hidden></p>
        <div class="memory-graph-canvas-wrap"><canvas id="memory-graph-canvas" width="960" height="560" role="img" aria-label="Interactive governed memory graph"></canvas></div>
      </div>
      <aside class="memory-graph-inspector">
        <h2>Selection</h2><div id="memory-graph-selection">${memoryNodeSelection(first)}</div>
        <hr><h2>Governed memory outline</h2>${memoryGraphOutline(model.nodes, model.groupRelated)}
        <hr><h2>Fact history</h2>${memoryEdgeList(model.edges)}
        <hr>${memoryGraphBoundary(model)}
      </aside>
    </section>
  </div>`;
}

export function bindMemoryGraph(root, {
  model,
  onSubmit,
  onHistoryChange,
  onGroupChange,
  onSelectNode
} = {}) {
  if (!root) return () => {};
  const controller = new AbortController();
  const signal = controller.signal;
  let viewport = null;
  root.querySelector('#memory-graph-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    onSubmit?.(memoryGraphOptionsFromForm(event.currentTarget), event);
  }, { signal });
  root.querySelector('#memory-graph-history')?.addEventListener('change', (event) => onHistoryChange?.(event.currentTarget.checked, event), { signal });
  root.querySelector('#memory-graph-communities')?.addEventListener('change', (event) => onGroupChange?.(event.currentTarget.checked, event), { signal });

  const canvas = root.querySelector('#memory-graph-canvas');
  if (canvas && model) {
    viewport = createGraphViewport(
      canvas,
      root.querySelector('.memory-graph-outline'),
      root.querySelector('#memory-graph-selection'),
      {
        nodes: model.nodes,
        edges: model.viewportEdges,
        onSelect: (node) => {
          const selection = root.querySelector('#memory-graph-selection');
          if (selection) selection.innerHTML = memoryNodeSelection(node);
          onSelectNode?.(node);
        },
        onError: (code) => {
          const failure = root.querySelector('[data-memory-graph-error]');
          if (!failure) return;
          failure.hidden = false;
          failure.textContent = code === 'graph_layout_bounds_exceeded'
            ? 'The visible memory graph exceeds the 200-node or 400-relationship display limit.'
            : 'Graph layout could not start. Use the governed memory outline.';
        }
      }
    );
    root.querySelector('[data-memory-graph-action="fit"]')?.addEventListener('click', () => viewport.fit(), { signal });
    root.querySelector('[data-memory-graph-action="reset"]')?.addEventListener('click', () => viewport.reset(), { signal });
  }
  return () => {
    controller.abort();
    viewport?.destroy();
  };
}

function memoryGraphHeading() {
  return '<header class="tool-page-heading"><div><p class="eyebrow">Governed repository memory</p><h1>Graph</h1><p>Inspect current and historical temporal facts from the local memory store.</p></div><span>Read-only / local SQLite</span></header>';
}

function renderMemoryGraphControls(model) {
  return `<section class="memory-graph-query"><form id="memory-graph-form" class="memory-graph-toolbar"><label class="field memory-graph-search"><span>Search entity</span><input name="query" value="${escapeHtml(model.query)}" placeholder="provider:native:memory:sqlite" maxlength="512"></label><label class="toggle-field"><input id="memory-graph-history" name="history" type="checkbox"${model.history ? ' checked' : ''}> <span>Show history</span></label><label class="toggle-field"><input id="memory-graph-communities" name="communities" type="checkbox"${model.groupRelated ? ' checked' : ''}> <span>Group related facts</span></label><button class="button primary" type="submit">Refresh</button></form></section>`;
}

function memoryGraphOutline(nodes, groupRelated) {
  let lastCommunity = null;
  return `<ol class="memory-graph-outline" aria-label="Governed memory outline">${nodes.map((node, index) => {
    const community = nonNegativeInteger(node.community);
    const groupLabel = groupRelated && community !== lastCommunity ? `<li class="memory-group-label">Related group ${community}</li>` : '';
    lastCommunity = community;
    return `${groupLabel}<li><button type="button" data-node-id="${escapeHtml(node.id)}"${index === 0 ? ' aria-current="true"' : ''}><strong>${escapeHtml(node.name ?? node.id)}</strong><span>${escapeHtml(memoryNodeStatus(node))} / ${escapeHtml(node.type ?? 'entity')}</span></button></li>`;
  }).join('')}</ol>`;
}

function memoryNodeSelection(node) {
  if (!node) return '<p>No selection.</p>';
  return `<dl class="facts compact-facts"><div><dt>Name</dt><dd>${escapeHtml(node.name ?? node.id)}</dd></div><div><dt>Status</dt><dd>${escapeHtml(memoryNodeStatus(node))}</dd></div><div><dt>Type</dt><dd>${escapeHtml(node.type ?? 'entity')}</dd></div><div><dt>Degree</dt><dd>${nonNegativeInteger(node.degree)}</dd></div>${node.governedDecision ? '<div><dt>Governance</dt><dd>Decision record</dd></div>' : ''}</dl>`;
}

function memoryEdgeList(edges) {
  if (!edges.length) return '<p>No relationships in the current scope.</p>';
  return `<ol class="memory-fact-list">${edges.slice(0, 16).map((edge) => `<li><strong>${escapeHtml(edge.from)} ${escapeHtml(edge.predicate)} ${escapeHtml(edge.to)}</strong><span>${escapeHtml(edge.current === false ? 'Superseded' : 'Current')}</span><small>Valid from ${escapeHtml(formatDate(edge.validFrom))} / Valid until ${edge.validUntil ? escapeHtml(formatDate(edge.validUntil)) : 'open'} / Provenance ${escapeHtml(edge.source ?? 'unavailable')}</small></li>`).join('')}</ol>`;
}

function memoryGraphBoundary(model) {
  const safeguards = model.safeguards ?? {};
  return `<section class="memory-graph-boundary"><h2>Provider check</h2><dl class="facts compact-facts"><div><dt>Provider</dt><dd>${escapeHtml(model.provider)}</dd></div><div><dt>Generated</dt><dd>${escapeHtml(formatDate(model.generatedAt))}</dd></div><div><dt>Read-only</dt><dd>${safeguards.readOnly === false ? 'no' : 'yes'}</dd></div><div><dt>Model calls</dt><dd>${nonNegativeInteger(safeguards.modelCalls)}</dd></div><div><dt>Network calls</dt><dd>${nonNegativeInteger(safeguards.networkCalls)}</dd></div><div><dt>External writes</dt><dd>${safeguards.externalWritesEnabled ? 'on' : 'off'}</dd></div></dl></section>`;
}

function memoryGraphOptionsFromForm(form) {
  const data = new FormData(form);
  return {
    query: String(data.get('query') ?? '').trim().slice(0, 512),
    history: data.get('history') === 'on',
    communities: data.get('communities') === 'on',
    entity: ''
  };
}

function filterMemoryGraph(nodes, edges, query) {
  if (!query) return { nodes: [...nodes], edges: [...edges] };
  const needle = query.toLocaleLowerCase();
  const selectedIds = new Set(nodes.filter((node) => [node.id, node.name, node.type].some((value) => String(value ?? '').toLocaleLowerCase().includes(needle))).map(({ id }) => id));
  for (const edge of edges) {
    const edgeMatches = [edge.from, edge.to, edge.predicate, edge.source].some((value) => String(value ?? '').toLocaleLowerCase().includes(needle));
    if (edgeMatches || selectedIds.has(edge.from) || selectedIds.has(edge.to)) {
      selectedIds.add(edge.from);
      selectedIds.add(edge.to);
    }
  }
  return {
    nodes: nodes.filter(({ id }) => selectedIds.has(id)),
    edges: edges.filter((edge) => selectedIds.has(edge.from) && selectedIds.has(edge.to))
  };
}

function memoryNodeStatus(node) {
  return node.current === false ? 'Historical' : 'Current';
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}
