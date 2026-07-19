import { escapeHtml, formatDate, renderApiErrorPanel, statePanel } from './ui-primitives.js';

export function renderOrientation(model) {
  if (model.state === 'loading') return orientationState('loading', model.title, model.copy, 'Scan repository');
  if (model.state === 'failure' || model.state === 'error') {
    return `<section class="orientation-workbench"><header class="orientation-heading"><h1>Overview</h1><button class="button" data-action="refresh-recall-map" type="button">Retry scan</button></header>${renderApiErrorPanel(model.title, model.error)}</section>`;
  }
  if (model.state === 'empty' && !model.repository) return orientationState('empty', model.title, model.copy, 'Scan repository');

  const groups = model.groups ?? [];
  const selectedGroup = groups.find(({ id }) => id === model.selectedGroupId) ?? groups[0] ?? null;
  const boardGroups = architectureBoardGroups(groups, selectedGroup?.id);
  const maxLayer = Math.max(0, ...boardGroups.map(({ layer = 0 }) => layer));
  const coverageLabel = coverageText(model.coverage);
  const architecture = groups.length
    ? `<div class="architecture-board" style="--orientation-layers:${maxLayer + 1}">${boardGroups.map((group) => groupButton(group, model.selectedGroupId)).join('')}${renderRelations(model.relations, boardGroups)}</div>${architectureDisclosure(groups.length, boardGroups.length)}${architectureOutline(groups, model.selectedGroupId)}`
    : renderIndexState(model.index);

  return `<section class="orientation-workbench" aria-labelledby="orientation-title">
    <header class="orientation-heading">
      <div><h1 id="orientation-title">Overview</h1><p>${escapeHtml(repositoryLine(model))}</p></div>
      <span class="coverage-label" data-status="${escapeHtml(model.coverage?.status ?? 'not-scanned')}">${escapeHtml(coverageLabel)}</span>
    </header>
    <div class="orientation-layout">
      <section class="architecture-region" aria-labelledby="architecture-title">
        <header class="region-heading"><div><h2 id="architecture-title">Architecture</h2><p>${escapeHtml(selectedGroupCopy(selectedGroup))}</p></div>${selectedGroup ? `<a href="/map?group=${encodeURIComponent(selectedGroup.prefix)}" data-route="source-graph">Open in Map</a>` : ''}</header>
        ${architecture}
      </section>
      <aside class="orientation-inspector" aria-label="Repository orientation details">
        ${renderStartHere(model.startHere)}
        ${renderImpact(model.impact)}
        ${renderTrust(model.trust)}
      </aside>
    </div>
  </section>`;
}

function renderIndexState(index = {}) {
  const command = index.recoveryCommand ? `<p>Run <code>${escapeHtml(index.recoveryCommand)}</code></p>` : '';
  const title = index.recoveryCommand ? (index.label || 'Source index unavailable') : 'No supported groups';
  return `${statePanel('empty', title, index.copy || 'The current index did not return repository groups inside its bounds.')}${command}<button class="button" data-action="refresh-recall-map" type="button">Reload index</button>`;
}

export function bindOrientation(root, { onSelectGroup, onRefresh } = {}) {
  if (!root) return () => {};
  const controller = new AbortController();
  const options = { signal: controller.signal };
  root.querySelectorAll('[data-group-id]').forEach((button) => button.addEventListener('click', () => onSelectGroup?.(button.dataset.groupId), options));
  root.querySelectorAll('[data-action="refresh-recall-map"]').forEach((button) => button.addEventListener('click', (event) => onRefresh?.(event), options));
  return () => controller.abort();
}

function orientationState(kind, title, copy, actionLabel) {
  return `<section class="orientation-workbench"><header class="orientation-heading"><h1>Overview</h1><button class="button primary" data-action="refresh-recall-map" type="button">${escapeHtml(actionLabel)}</button></header>${statePanel(kind, title, copy)}</section>`;
}

function groupButton(group, selectedGroupId) {
  const selected = group.id === selectedGroupId;
  return `<button type="button" class="orientation-group${selected ? ' is-selected' : ''}" style="--orientation-layer:${Number(group.layer ?? 0)}" data-group-id="${escapeHtml(group.id)}" aria-pressed="${selected ? 'true' : 'false'}"><strong>${escapeHtml(group.label)}</strong><span>${escapeHtml(group.prefix)}</span><small>${Number(group.fileCount ?? 0)} files / ${Number(group.symbolCount ?? 0)} symbols${group.changedFileCount ? ` / ${Number(group.changedFileCount)} changed` : ''}</small></button>`;
}

function renderRelations(relations = [], groups = []) {
  const byId = new Map(groups.map((group) => [group.id, group]));
  if (!relations.length) return '';
  return `<div class="orientation-relations" aria-hidden="true">${relations.map((relation) => {
    const source = byId.get(relation.sourceGroupId);
    const target = byId.get(relation.targetGroupId);
    if (!source || !target) return '';
    return `<span>${escapeHtml(source.label)} to ${escapeHtml(target.label)} <b>${Number(relation.count ?? 0)}</b></span>`;
  }).join('')}</div>`;
}

function architectureBoardGroups(groups, selectedGroupId) {
  const maximum = 6;
  if (groups.length <= maximum) return groups;
  const selected = groups.find(({ id }) => id === selectedGroupId);
  if (!selected || groups.slice(0, maximum).some(({ id }) => id === selected.id)) return groups.slice(0, maximum);
  return [...groups.slice(0, maximum - 1), selected];
}

function architectureDisclosure(total, shown) {
  if (shown >= total) return '';
  return `<p class="architecture-disclosure">Showing ${shown} of ${total} groups. Open the outline for the complete bounded map.</p>`;
}

function architectureOutline(groups, selectedGroupId) {
  return `<details class="architecture-outline"><summary>Repository architecture outline</summary><ol aria-label="Repository architecture outline">${groups.map((group) => `<li><button type="button" data-group-id="${escapeHtml(group.id)}"${group.id === selectedGroupId ? ' aria-current="true"' : ''}><strong>${escapeHtml(group.prefix)}</strong><span>Layer ${Number(group.layer ?? 0) + 1}, ${Number(group.fileCount ?? 0)} files</span></button></li>`).join('')}</ol></details>`;
}

function renderStartHere(items = []) {
  const content = items.length
    ? `<ol>${items.map((item) => `<li class="start-item"><a href="/map?query=${encodeURIComponent(item.label)}" data-route="source-graph"><strong>${escapeHtml(item.label)}</strong><code>${escapeHtml(item.locator)}</code><span>${escapeHtml(item.reason)}</span></a></li>`).join('')}</ol>`
    : '<p>No ranked entry points in the current bounds.</p>';
  return `<section class="start-here"><header><h2>Start here</h2><span>${items.length} ranked</span></header>${content}</section>`;
}

function renderImpact(impact = {}) {
  const affected = impact.affectedSymbols ?? [];
  const detail = impact.status === 'clean'
    ? '<p>No local changes detected.</p>'
    : `<p>${escapeHtml(impact.label ?? 'Change state unavailable')}</p>${affected.length ? `<ol>${affected.slice(0, 3).map((item) => `<li><strong>${escapeHtml(item.label)}</strong><code>${escapeHtml(item.locator)}</code></li>`).join('')}</ol>` : ''}${impact.unrepresentedChangedCount ? `<small>${Number(impact.unrepresentedChangedCount)} changed file${impact.unrepresentedChangedCount === 1 ? '' : 's'} outside the represented graph.</small>` : ''}`;
  return `<section class="current-impact"><header><h2>Current impact</h2><span>${Number(impact.affectedCount ?? 0)} affected</span></header>${detail}</section>`;
}

function renderTrust(trust = {}) {
  const memory = trust.memory ?? {};
  const handoff = trust.handoff ?? {};
  const source = trust.source ?? {};
  return `<section class="trusted-context"><header><h2>Trusted context</h2></header><dl class="trust-list"><div><dt>Source map</dt><dd>${escapeHtml(source.status ?? 'not scanned')}</dd></div><div><dt>Memory</dt><dd>${escapeHtml(memory.status ?? 'unavailable')}${memory.pendingCount ? `, ${Number(memory.pendingCount)} pending` : ''}</dd></div><div><dt>Handoff</dt><dd>${escapeHtml(handoff.status ?? 'not pinned')}</dd></div>${trust.deliveryReduction ? `<div><dt>Measured delivery</dt><dd>${Number(trust.deliveryReduction.percent)}% fewer tokens</dd></div>` : ''}</dl></section>`;
}

function coverageText(coverage = {}) {
  const status = coverage.status === 'failed' ? 'Unavailable' : titleCase(coverage.status || 'not scanned');
  const built = coverage.builtAt ? ` / built ${formatDate(coverage.builtAt)}` : '';
  return `${status}${built}`;
}

function repositoryLine(model) {
  const repository = model.repository ?? {};
  return [repository.name, repository.branch, model.coverage?.label].filter(Boolean).join(' / ');
}

function selectedGroupCopy(group) {
  return group ? `${group.prefix}. ${group.fileCount} files and ${group.symbolCount} symbols.` : 'Bounded local index structure.';
}

function titleCase(value) {
  const text = String(value ?? '').replaceAll('-', ' ');
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}
