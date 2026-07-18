import { buildApiErrorUiModel } from './ui-primitives.js';
import { selectOverviewPrimaryAction } from './shell-model.js';

const MAX_GROUPS = 12;
const MAX_RELATIONS = 20;
const MAX_START_ITEMS = 3;
const START_REASON_PRIORITY = new Map([
  ['application_route', 0],
  ['package_entry_point', 1],
  ['changed_central_module', 2],
  ['executable_command', 3],
  ['inbound_dependency_hub', 4]
]);
const START_REASON_LABEL = new Map([
  ['application_route', 'application route'],
  ['package_entry_point', 'package entry point'],
  ['changed_central_module', 'changed central module'],
  ['executable_command', 'executable command'],
  ['inbound_dependency_hub', 'inbound dependency hub']
]);

export function buildOrientationModel({
  report = null,
  loading = false,
  error = null,
  gitChanges = null,
  handoff = null,
  handoffError = null,
  selectedGroupId = null,
  now = null
} = {}) {
  if (loading) return frozenState('loading', 'Loading repository map', 'Reading bounded local source metadata.');
  if (error) return Object.freeze({
    state: 'failure',
    error: buildApiErrorUiModel(error),
    title: 'Repository map unavailable',
    copy: 'The local API did not return a map. Retry the read-only request.',
    groups: Object.freeze([]),
    relations: Object.freeze([]),
    startHere: Object.freeze([])
  });
  if (!report) return frozenState('empty', 'Repository index unavailable', 'Build the local index, then reload this page.');

  const architecture = objectValue(report.architecture);
  const repository = normalizeRepository(report.repository);
  const sourceGraph = objectValue(report.support?.sourceGraph);
  const snapshot = objectValue(sourceGraph.snapshot);
  const coverage = normalizeCoverage(sourceGraph, snapshot);
  const rawGroups = arrayValue(architecture.groups).slice(0, MAX_GROUPS).map(normalizeGroup);
  const groupIds = new Set(rawGroups.map(({ id }) => id));
  const relations = Object.freeze(arrayValue(architecture.groupRelations)
    .map(normalizeRelation)
    .filter((relation) => groupIds.has(relation.sourceGroupId) && groupIds.has(relation.targetGroupId))
    .sort(compareRelations)
    .slice(0, MAX_RELATIONS));
  const groups = Object.freeze(layerOrientationGroups(rawGroups, relations));
  const impact = normalizeImpact(architecture.impact, gitChanges, repository);
  const startHere = Object.freeze(rankStartHere(startCandidates(architecture, groups, impact)));
  const memory = normalizeMemory(report.memory);
  const handoffModel = normalizeHandoff({ report, handoff, handoffError, now });
  const selected = chooseSelectedGroup(groups, selectedGroupId);
  const noArchitecture = groups.length === 0
    && startHere.length === 0
    && arrayValue(architecture.hotspots).length === 0
    && impact.changedLocators.length === 0
    && impact.affectedSymbols.length === 0;
  const state = coverage.status === 'stale' || handoffModel.state === 'review'
    ? 'stale'
    : noArchitecture
      ? 'empty'
      : coverage.status === 'failed'
        ? 'partial'
        : 'success';
  const commands = normalizeCommands(report);
  const recentActivity = normalizeActivity(report.memory);
  const nativeIndex = arrayValue(sourceGraph.languages).length > 2;
  const indexRecovery = sourceIndexRecovery(snapshot.reason);
  const trust = Object.freeze({
    memory: Object.freeze({
      status: memory.pendingCount > 0 ? 'pending' : memory.staleCount > 0 ? 'stale' : memory.status === 'available' ? 'current' : memory.status,
      activeCount: memory.activeCount,
      pendingCount: memory.pendingCount,
      staleCount: memory.staleCount,
      conflictingCount: memory.conflictingCount
    }),
    handoff: Object.freeze({
      status: handoffModel.status,
      state: handoffModel.state,
      createdAt: handoffModel.createdAt,
      ageLabel: handoffModel.ageLabel
    }),
    source: Object.freeze({
      status: coverage.status,
      snapshotStatus: coverage.snapshotStatus,
      reuse: coverage.reuse
    }),
    deliveryReduction: measuredDeliveryReduction(report)
  });
  const model = {
    state,
    generatedAt: safeNullableText(report.generatedAt, 64),
    repository,
    coverage,
    groups,
    relations,
    selectedGroupId: selected,
    startHere,
    impact,
    trust,
    index: Object.freeze({
      status: safeText(sourceGraph.status || 'unavailable', 32),
      kind: sourceGraph.status === 'implemented' ? 'success' : 'error',
      label: sourceGraph.status === 'implemented' ? (nativeIndex ? 'Native index ready' : 'JS/TS map indexed') : 'Source graph unavailable',
      copy: sourceGraph.status === 'implemented' ? 'Bounded local metadata only; raw source bodies stay local.' : indexRecovery.copy,
      recoveryCommand: sourceGraph.status === 'implemented' ? null : indexRecovery.command
    }),
    entryPoints: Object.freeze(arrayValue(architecture.entryPoints).map(normalizeStartItem)),
    hotspots: Object.freeze(arrayValue(architecture.hotspots).map(normalizeStartItem)),
    memory,
    handoff: handoffModel,
    safeguards: Object.freeze({ ...objectValue(report.safeguards) }),
    commands,
    recentActivity
  };
  model.primaryAction = selectOverviewPrimaryAction(model);
  return Object.freeze(model);
}

function sourceIndexRecovery(reason) {
  const code = String(reason ?? '').split(':').at(-1);
  if (code === 'source_index_build_required') {
    return Object.freeze({ copy: 'Build the local source index, then refresh this page.', command: 'recall graph index --write --engine native --root . --format summary' });
  }
  if (code === 'source_index_refresh_required') {
    return Object.freeze({ copy: 'Refresh the stale source index, then reload this page.', command: 'recall graph index --refresh --engine native --root . --format summary' });
  }
  if (['source_index_repair_required', 'source_index_migration_required', 'source_index_wrong_repository'].includes(code)) {
    return Object.freeze({ copy: 'Inspect the local source index and apply the exact repair command it reports.', command: 'recall graph index --doctor --engine native --root . --format summary' });
  }
  if (code === 'source_index_schema_newer') {
    return Object.freeze({ copy: 'Use a Memory Recall version compatible with this newer source index.', command: null });
  }
  if (['native_platform_package_missing', 'native_engine_unavailable'].includes(code)) {
    return Object.freeze({ copy: 'Install the matching Memory Recall native package, then reload this page.', command: 'npm install -g memory-recall' });
  }
  return Object.freeze({ copy: 'The local source index could not be read. Check it, then reload this page.', command: 'recall graph index --doctor --engine native --root . --format summary' });
}

export function layerOrientationGroups(inputGroups = [], inputRelations = []) {
  const groups = inputGroups.slice(0, MAX_GROUPS).map((group) => ({ ...group }));
  const byId = new Map(groups.map((group) => [group.id, group]));
  const adjacency = new Map(groups.map((group) => [group.id, []]));
  for (const relation of inputRelations.slice(0, MAX_RELATIONS)) {
    if (!byId.has(relation.sourceGroupId) || !byId.has(relation.targetGroupId)) continue;
    adjacency.get(relation.sourceGroupId).push(relation.targetGroupId);
  }
  for (const targets of adjacency.values()) targets.sort(compareGroupIds(byId));
  const components = stronglyConnectedComponents(groups, adjacency);
  const componentByGroup = new Map();
  components.forEach((component, index) => component.forEach((id) => componentByGroup.set(id, index)));
  const predecessors = new Map(components.map((_, index) => [index, new Set()]));
  for (const [source, targets] of adjacency) {
    for (const target of targets) {
      const sourceComponent = componentByGroup.get(source);
      const targetComponent = componentByGroup.get(target);
      if (sourceComponent !== targetComponent) predecessors.get(targetComponent).add(sourceComponent);
    }
  }
  const componentLayers = new Map();
  const layerFor = (component) => {
    if (componentLayers.has(component)) return componentLayers.get(component);
    const previous = [...predecessors.get(component)].map(layerFor);
    const layer = previous.length ? Math.max(...previous) + 1 : 0;
    componentLayers.set(component, layer);
    return layer;
  };
  components.forEach((_, index) => layerFor(index));
  return groups
    .map((group) => Object.freeze({ ...group, layer: componentLayers.get(componentByGroup.get(group.id)) ?? 0 }))
    .sort((left, right) => left.layer - right.layer || left.prefix.localeCompare(right.prefix));
}

export function selectOrientationGroup(model, groupId) {
  const selected = model?.groups?.some(({ id }) => id === groupId) ? groupId : model?.selectedGroupId ?? null;
  return Object.freeze({ ...model, selectedGroupId: selected });
}

export function normalizeOrientationGitChanges(report = null, error = null) {
  const empty = { changedLocators: [], totalCount: 0, omittedCount: 0, truncated: false };
  if (error) return { status: 'error', ...empty, reason: safeText(error?.code || 'git_detection_failed', 64), message: safeGitMessage(error?.message, 'Git change detection failed. Retry the local scan.') };
  if (report?.status === 'error') return { status: 'error', ...empty, reason: safeText(report.reason || 'git_detection_failed', 64), message: safeGitMessage(report.message, 'Git change detection failed. Retry the local scan.') };
  if (report?.status === 'unavailable') {
    const reason = safeText(report.reason || 'git_unavailable', 64);
    return { status: 'unavailable', ...empty, reason, message: gitUnavailableMessage(reason) };
  }
  if (report?.status !== 'available') return { status: 'unknown', ...empty, reason: 'not_run', message: 'Git change detection has not run.' };
  const changedLocators = arrayValue(report.changedLocators).map((value) => safeText(value, 512).replace(/^workspace:\/\//u, '')).filter(Boolean).slice(0, 16);
  const skippedCount = Math.max(0, finiteNumber(report.skippedCount));
  const totalBase = finiteNumber(report.totalCount ?? report.totalChangedLocatorCount ?? changedLocators.length);
  const omittedBase = finiteNumber(report.omittedCount ?? report.omittedChangedLocatorCount ?? 0);
  return {
    status: 'available',
    changedLocators,
    totalCount: Math.max(changedLocators.length, totalBase + (report.totalCount == null ? skippedCount : 0)),
    omittedCount: Math.max(0, omittedBase) + (report.omittedCount == null ? skippedCount : 0),
    truncated: report.truncated === true
  };
}

function normalizeRepository(value) {
  const repository = objectValue(value);
  return Object.freeze({
    name: safeText(repository.name || 'Local workspace', 160),
    branch: safeNullableText(repository.branch, 160),
    commitSha: safeNullableText(repository.commitSha, 64),
    dirtyCount: finiteNumber(repository.dirtyCount),
    gitStatusAvailable: repository.gitStatusAvailable === true,
    reason: safeNullableText(repository.reason, 64)
  });
}

function normalizeCoverage(sourceGraph, snapshot) {
  const raw = objectValue(sourceGraph.coverage);
  const rawStatus = safeText(raw.status || 'unavailable', 32);
  const snapshotStatus = safeText(snapshot.status || (sourceGraph.status === 'implemented' ? 'fresh' : 'unavailable'), 32);
  const status = snapshotStatus === 'stale' || rawStatus === 'stale'
    ? 'stale'
    : sourceGraph.status !== 'implemented' || rawStatus === 'unavailable' || snapshotStatus === 'unavailable'
      ? 'failed'
      : rawStatus === 'complete'
        ? 'complete'
        : 'partial';
  return Object.freeze({
    status,
    rawStatus,
    snapshotStatus,
    reuse: safeText(snapshot.reuse || 'none', 32),
    builtAt: safeNullableText(snapshot.builtAt, 64),
    buildDurationMs: snapshot.buildDurationMs == null ? null : finiteNumber(snapshot.buildDurationMs),
    analyzedFileCount: finiteNumber(raw.analyzedFileCount),
    maxFiles: finiteNumber(raw.maxFiles),
    label: `${finiteNumber(raw.analyzedFileCount)} / ${finiteNumber(raw.maxFiles)} files`,
    diagnosticCount: finiteNumber(raw.diagnosticCount),
    reasonCodes: Object.freeze(arrayValue(raw.reasonCodes).map((code) => safeText(code, 64)).filter(Boolean).slice(0, 16)),
    reason: safeNullableText(snapshot.reason, 64),
    lastValidSnapshotShown: status === 'stale'
  });
}

function normalizeGroup(group, index) {
  const value = objectValue(group);
  const prefix = safeText(value.prefix || value.label || `group-${index + 1}`, 512);
  return Object.freeze({
    id: safeText(value.id || `group_${index}`, 96),
    label: safeText(value.label || prefix.split('/').at(-1) || prefix, 160),
    prefix,
    fileCount: finiteNumber(value.fileCount),
    symbolCount: finiteNumber(value.symbolCount),
    changedFileCount: finiteNumber(value.changedFileCount),
    coverageStatus: safeText(value.coverageStatus || 'complete', 32),
    entryPoints: Object.freeze(arrayValue(value.entryPoints).slice(0, 2).map(normalizeStartItem))
  });
}

function normalizeRelation(relation, index) {
  const value = objectValue(relation);
  return Object.freeze({
    id: safeText(value.id || `relation_${index}`, 96),
    sourceGroupId: safeText(value.sourceGroupId || value.fromGroupId, 96),
    targetGroupId: safeText(value.targetGroupId || value.toGroupId, 96),
    sourcePrefix: safeText(value.sourcePrefix, 512),
    targetPrefix: safeText(value.targetPrefix, 512),
    kind: safeText(value.kind || dominantKind(value.edgeKindCounts), 32),
    count: finiteNumber(value.count),
    edgeKindCounts: Object.freeze({ ...objectValue(value.edgeKindCounts) })
  });
}

function normalizeImpact(rawImpact, rawGitChanges, repository) {
  const impact = objectValue(rawImpact);
  const changedLocators = Object.freeze(arrayValue(impact.changedLocators).map((value) => safeText(value, 512)).filter(Boolean).slice(0, 16));
  const representedChangedLocators = Object.freeze(arrayValue(impact.representedChangedLocators).map((value) => safeText(value, 512)).filter(Boolean).slice(0, 16));
  const affectedSymbols = Object.freeze(arrayValue(impact.affectedSymbols).map(normalizeStartItem).slice(0, 20));
  const detected = normalizeOrientationGitChanges(rawGitChanges);
  const totalChangedCount = detected.status === 'available' ? detected.totalCount : changedLocators.length;
  const unrepresentedChangedCount = Math.max(0, totalChangedCount - representedChangedLocators.length);
  const status = detected.status === 'available' && totalChangedCount === 0 && repository.dirtyCount === 0
    ? 'clean'
    : detected.status === 'unavailable' || detected.status === 'error'
      ? 'unknown'
      : totalChangedCount > 0 || changedLocators.length > 0
        ? 'changed'
        : 'not scanned';
  return Object.freeze({
    status,
    label: status === 'clean' ? 'No local changes detected' : status === 'changed' ? `${totalChangedCount} local change${totalChangedCount === 1 ? '' : 's'}` : status === 'unknown' ? 'Local change detection unavailable' : 'Local changes not scanned',
    changedLocators,
    representedChangedLocators,
    affectedSymbols,
    changedCount: changedLocators.length,
    representedCount: representedChangedLocators.length,
    unrepresentedChangedCount,
    affectedCount: affectedSymbols.length,
    totalChangedCount,
    omittedChangedCount: detected.status === 'available' ? detected.omittedCount : 0,
    truncated: detected.truncated === true,
    detectionStatus: detected.status,
    detectionReason: detected.reason,
    detectionMessage: detected.message,
    repositoryDirtyCount: repository.dirtyCount,
    depth: finiteNumber(impact.depth)
  });
}

function normalizeMemory(rawMemory) {
  const memory = objectValue(rawMemory);
  const activeFacts = Object.freeze(arrayValue(memory.activeFacts).slice(0, 20));
  const pendingProposals = Object.freeze(arrayValue(memory.pendingProposals).slice(0, 20));
  const staleCount = finiteNumber(memory.staleFactCount);
  return Object.freeze({
    status: safeText(memory.status || 'unavailable', 32),
    kind: memory.status === 'available' ? (staleCount > 0 ? 'stale' : 'success') : 'error',
    activeFacts,
    pendingProposals,
    activeCount: activeFacts.length,
    pendingCount: pendingProposals.length,
    staleCount,
    conflictingCount: finiteNumber(memory.conflictingFactCount),
    unavailableReason: safeNullableText(memory.unavailableReason, 64)
  });
}

function normalizeHandoff({ report, handoff, handoffError, now }) {
  const raw = objectValue(handoff);
  const current = objectValue(raw.current);
  const status = safeText(raw.status || current.status || '', 32);
  const entryId = current.entryId ?? raw.entryId ?? null;
  const entry = arrayValue(raw.entries).find(({ id }) => id === entryId) ?? null;
  const createdAt = safeNullableText(raw.createdAt ?? entry?.createdAt, 64);
  const state = handoffError
    ? 'blocked'
    : status === 'verified'
      ? 'ready'
      : ['stale', 'review'].includes(status)
        ? 'review'
        : status === 'tampered'
          ? 'blocked'
          : report.readiness?.handoff?.status === 'available'
            ? 'pending'
            : 'blocked';
  const end = now ?? raw.generatedAt ?? report.generatedAt;
  return Object.freeze({
    state,
    status: status || (state === 'pending' ? 'available' : state),
    kind: state === 'ready' ? 'success' : state === 'review' || state === 'pending' ? 'partial' : 'error',
    command: safeText(report.readiness?.handoff?.command || 'recall handoff', 256),
    createdAt,
    ageLabel: relativeAge(createdAt, end),
    copy: state === 'ready'
      ? 'Pinned handoff is verified for the next coding agent.'
      : state === 'review'
        ? 'Pinned sources changed and need review before handoff.'
        : state === 'pending'
          ? 'The handoff command is available; no verified pinned packet is active.'
          : 'Handoff verification is unavailable. Review the local registry before sharing context.'
  });
}

function startCandidates(architecture, groups, impact) {
  const changed = new Set(impact.changedLocators.map(fileLocator));
  const candidates = [
    ...arrayValue(architecture.entryPoints),
    ...groups.flatMap(({ entryPoints }) => entryPoints),
    ...arrayValue(architecture.hotspots).map((item) => ({ ...item, reasonCodes: item.reasonCodes ?? ['inbound_dependency_hub'], score: item.score ?? item.total ?? item.inbound ?? 0 }))
  ];
  const seen = new Set();
  return candidates.map((item) => {
    const normalized = normalizeStartItem(item);
    const reasonCode = safeText(arrayValue(item?.reasonCodes)[0] || item?.reasonCode || inferStartReason(normalized, changed), 64);
    return { ...normalized, reasonCode, score: finiteNumber(item?.score ?? item?.total ?? 0) };
  }).filter((item) => {
    const key = `${item.locator}\u0000${item.label}`;
    if (!item.locator || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rankStartHere(items) {
  const ranked = [...items]
    .filter(({ locator = '' }) => !/(?:^|\/)(?:test|tests|fixtures|generated|vendor)(?:\/|$)/iu.test(locator.replace(/^workspace:\/\//u, '')))
    .sort((left, right) => (
      (START_REASON_PRIORITY.get(left.reasonCode) ?? 99) - (START_REASON_PRIORITY.get(right.reasonCode) ?? 99)
      || right.score - left.score
      || left.locator.localeCompare(right.locator)
      || left.label.localeCompare(right.label)
    ));
  const selected = [];
  const selectedReasons = new Set();
  for (const item of ranked) {
    if (selectedReasons.has(item.reasonCode)) continue;
    selected.push(item);
    selectedReasons.add(item.reasonCode);
    if (selected.length === MAX_START_ITEMS) break;
  }
  for (const item of ranked) {
    if (selected.length === MAX_START_ITEMS) break;
    if (!selected.includes(item)) selected.push(item);
  }
  return selected.map((item) => Object.freeze({ ...item, reason: START_REASON_LABEL.get(item.reasonCode) ?? 'ranked source entry point' }));
}

function normalizeStartItem(value) {
  const item = objectValue(value);
  return Object.freeze({
    nodeId: safeNullableText(item.nodeId, 96),
    label: safeText(item.label || item.name || 'Unnamed source', 240),
    qualifiedLabel: safeNullableText(item.qualifiedLabel || item.qualifiedName, 240),
    locator: safeNullableText(item.locator, 512),
    symbolKind: safeText(item.symbolKind || item.kind || 'module', 32)
  });
}

function inferStartReason(item, changed) {
  const locator = String(item.locator ?? '').replace(/^workspace:\/\//u, '').split('#', 1)[0];
  if (/(?:^|\/)route\.(?:[cm]?[jt]sx?)$/iu.test(locator)) return 'application_route';
  if (/(?:^|\/)(?:index|main)\.(?:[cm]?[jt]sx?)$/iu.test(locator)) return 'package_entry_point';
  if (changed.has(fileLocator(locator))) return 'changed_central_module';
  if (/^(?:apps\/cli|bin\/)|\/bin\//u.test(locator)) return 'executable_command';
  return 'inbound_dependency_hub';
}

function stronglyConnectedComponents(groups, adjacency) {
  let nextIndex = 0;
  const stack = [];
  const onStack = new Set();
  const indexById = new Map();
  const lowById = new Map();
  const components = [];
  const visit = (id) => {
    indexById.set(id, nextIndex);
    lowById.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    onStack.add(id);
    for (const target of adjacency.get(id) ?? []) {
      if (!indexById.has(target)) {
        visit(target);
        lowById.set(id, Math.min(lowById.get(id), lowById.get(target)));
      } else if (onStack.has(target)) {
        lowById.set(id, Math.min(lowById.get(id), indexById.get(target)));
      }
    }
    if (lowById.get(id) !== indexById.get(id)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== id);
    component.sort(compareGroupIds(new Map(groups.map((group) => [group.id, group]))));
    components.push(component);
  };
  [...groups].sort((left, right) => left.prefix.localeCompare(right.prefix)).forEach(({ id }) => {
    if (!indexById.has(id)) visit(id);
  });
  return components;
}

function normalizeCommands(report) {
  const commands = [
    'recall map --root . --sqlite .local/memory.sqlite --format summary',
    ...arrayValue(report.readiness?.nextCommands),
    report.readiness?.mcp?.command
  ].filter((command, index, all) => typeof command === 'string' && command.length > 0 && all.indexOf(command) === index).slice(0, 5);
  return Object.freeze(commands.map((command) => Object.freeze({ label: commandLabel(command), command })));
}

function normalizeActivity(rawMemory) {
  const memory = objectValue(rawMemory);
  return Object.freeze([
    ...arrayValue(memory.pendingProposals).slice(0, 3).map((proposal) => ({ kind: 'proposal', label: 'Memory proposed', detail: safeNullableText(proposal.sourceLocator, 512), at: safeNullableText(proposal.enqueuedAt, 64) })),
    ...arrayValue(memory.activeFacts).slice(0, 3).map((fact) => ({ kind: 'memory', label: 'Memory current', detail: safeNullableText(fact.sourceLocator, 512), at: safeNullableText(fact.validFrom, 64) }))
  ].sort((left, right) => String(right.at).localeCompare(String(left.at))).slice(0, 5).map(Object.freeze));
}

function measuredDeliveryReduction(report) {
  const measurement = objectValue(report.deliveryMeasurement ?? report.measurements?.delivery ?? report.memory?.deliveryMeasurement);
  const before = finiteNumber(measurement.beforeDeliveryTokens ?? measurement.baselineTokens);
  const after = finiteNumber(measurement.afterDeliveryTokens ?? measurement.deliveredTokens);
  if (measurement.providerBillingClaimed !== false || before <= 0 || after < 0 || after > before) return null;
  return Object.freeze({ before, after, tokensSaved: before - after, percent: Math.round(((before - after) / before) * 100), providerBillingClaimed: false });
}

function chooseSelectedGroup(groups, requested) {
  if (groups.some(({ id }) => id === requested)) return requested;
  return groups.find(({ changedFileCount }) => changedFileCount > 0)?.id ?? groups[0]?.id ?? null;
}

function compareRelations(left, right) {
  return right.count - left.count || left.sourceGroupId.localeCompare(right.sourceGroupId) || left.targetGroupId.localeCompare(right.targetGroupId);
}

function compareGroupIds(byId) {
  return (left, right) => (byId.get(left)?.prefix ?? left).localeCompare(byId.get(right)?.prefix ?? right);
}

function dominantKind(counts) {
  return Object.entries(objectValue(counts)).sort((left, right) => finiteNumber(right[1]) - finiteNumber(left[1]) || left[0].localeCompare(right[0]))[0]?.[0] ?? 'imports';
}

function commandLabel(command) {
  if (command.startsWith('recall map')) return 'Refresh map locally';
  if (command.startsWith('recall handoff')) return 'Create handoff';
  if (command.includes('mcp inspect')) return 'Inspect read-only MCP';
  if (command.includes('graph stats')) return 'Check source graph';
  return 'Copy command';
}

function relativeAge(from, to) {
  const start = Date.parse(String(from ?? ''));
  const end = Date.parse(String(to ?? ''));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 'Not pinned';
  const minutes = Math.floor((end - start) / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} old`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} old`;
}

function fileLocator(locator) {
  return String(locator ?? '').replace(/^workspace:\/\//u, '').split('#', 1)[0];
}

function safeGitMessage(value, fallback) {
  const message = safeText(value, 180);
  return !message || /(?:\/Users|\/private|\/var\/folders|https?:|file:|token|secret|api[_-]?key|authorization|cookie)/iu.test(message) ? fallback : message;
}

function gitUnavailableMessage(reason) {
  return ({
    not_git_repository: 'Git change detection is unavailable because this workspace is not a Git repository.',
    git_unavailable: 'Git change detection is unavailable because the local Git executable could not be used.',
    git_status_failed: 'Git change detection is unavailable because local status could not be read.',
    git_status_timeout: 'Git change detection is unavailable because local status timed out.'
  })[reason] ?? 'Git change detection is unavailable. Retry the local scan.';
}

function frozenState(state, title, copy) {
  return Object.freeze({ state, title, copy, groups: Object.freeze([]), relations: Object.freeze([]), startHere: Object.freeze([]) });
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeText(value, maxLength = 240) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, maxLength);
}

function safeNullableText(value, maxLength) {
  const text = safeText(value, maxLength);
  return text || null;
}

function finiteNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}
