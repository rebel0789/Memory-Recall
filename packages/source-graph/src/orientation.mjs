import { hashRef } from '../../context-compiler/src/index.mjs';

const GROUP_ROOTS = new Set(['apps', 'packages', 'services', 'plugins', 'examples', 'tests', 'scripts']);
const FOCUS_EDGE_ORDER = Object.freeze(['calls', 'imports', 'exports', 'defined_in', 'contains', 'references']);
const MAX_GROUPS = 12;
const MAX_RELATIONS = 20;
const MAX_FOCUS_NODES = 200;
const MAX_FOCUS_EDGES = 400;

export function buildSourceGraphOrientation(graph, {
  changedLocators = [],
  entryPoints = [],
  maxGroups = MAX_GROUPS,
  maxRelations = MAX_RELATIONS
} = {}) {
  assertGraph(graph);
  const groupLimit = boundedInteger(maxGroups, 'source_graph_orientation_max_groups', 1, MAX_GROUPS);
  const relationLimit = boundedInteger(maxRelations, 'source_graph_orientation_max_relations', 1, MAX_RELATIONS);
  const changedFiles = new Set(changedLocators.map(fileLocator).filter(Boolean));
  const groupsByPrefix = new Map();

  for (const node of [...graph.nodes].sort(byId)) {
    if (!['file', 'symbol'].includes(node.kind)) continue;
    const prefix = groupPrefix(node.locator);
    const locator = fileLocator(node.locator);
    if (!prefix || !locator) continue;
    const group = groupsByPrefix.get(prefix) ?? {
      id: stableId('sggroup', prefix),
      prefix,
      fileLocators: new Set(),
      symbolCount: 0,
      entryPoints: []
    };
    group.fileLocators.add(locator);
    if (node.kind === 'symbol') group.symbolCount += 1;
    groupsByPrefix.set(prefix, group);
  }

  for (const entryPoint of entryPoints ?? []) {
    const prefix = groupPrefix(entryPoint.locator);
    const group = groupsByPrefix.get(prefix);
    if (!group || group.entryPoints.length >= 2) continue;
    group.entryPoints.push(Object.freeze(compactEntryPoint(entryPoint)));
  }

  const candidates = [...groupsByPrefix.values()].map((group) => Object.freeze({
    id: group.id,
    prefix: group.prefix,
    fileCount: group.fileLocators.size,
    symbolCount: group.symbolCount,
    changedFileCount: [...group.fileLocators].filter((locator) => changedFiles.has(locator)).length,
    entryPoints: Object.freeze(group.entryPoints)
  }));
  const groups = candidates
    .sort((left, right) => (
      right.changedFileCount - left.changedFileCount
      || right.entryPoints.length - left.entryPoints.length
      || right.symbolCount - left.symbolCount
      || right.fileCount - left.fileCount
      || left.prefix.localeCompare(right.prefix)
    ))
    .slice(0, groupLimit)
    .sort((left, right) => left.prefix.localeCompare(right.prefix));
  const selectedPrefixes = new Set(groups.map(({ prefix }) => prefix));
  const relationsByKey = new Map();
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

  for (const edge of [...graph.edges].sort(byId)) {
    if (!['imports', 'calls'].includes(edge.kind)) continue;
    const sourcePrefix = groupPrefix(nodeById.get(edge.fromNodeId)?.locator);
    const targetPrefix = groupPrefix(nodeById.get(edge.toNodeId)?.locator);
    if (!sourcePrefix || !targetPrefix || sourcePrefix === targetPrefix) continue;
    if (!selectedPrefixes.has(sourcePrefix) || !selectedPrefixes.has(targetPrefix)) continue;
    const key = `${sourcePrefix}\u0000${targetPrefix}`;
    const relation = relationsByKey.get(key) ?? {
      id: stableId('sgrelation', key),
      sourceGroupId: stableId('sggroup', sourcePrefix),
      targetGroupId: stableId('sggroup', targetPrefix),
      sourcePrefix,
      targetPrefix,
      count: 0,
      edgeKindCounts: {}
    };
    relation.count += 1;
    relation.edgeKindCounts[edge.kind] = (relation.edgeKindCounts[edge.kind] ?? 0) + 1;
    relationsByKey.set(key, relation);
  }

  const relations = [...relationsByKey.values()]
    .map((relation) => Object.freeze({
      ...relation,
      edgeKindCounts: Object.freeze(Object.fromEntries(Object.entries(relation.edgeKindCounts).sort()))
    }))
    .sort((left, right) => right.count - left.count || left.sourcePrefix.localeCompare(right.sourcePrefix) || left.targetPrefix.localeCompare(right.targetPrefix))
    .slice(0, relationLimit);

  return Object.freeze({
    groups: Object.freeze(groups),
    relations: Object.freeze(relations)
  });
}

export function buildSourceGraphFocus(graph, {
  seedNodeIds = [],
  locatorPrefix = null,
  nodeLimit = MAX_FOCUS_NODES,
  edgeLimit = MAX_FOCUS_EDGES
} = {}) {
  assertGraph(graph);
  const boundedNodeLimit = boundedInteger(nodeLimit, 'source_graph_focus_node_limit', 1, MAX_FOCUS_NODES);
  const boundedEdgeLimit = boundedInteger(edgeLimit, 'source_graph_focus_edge_limit', 1, MAX_FOCUS_EDGES);
  const prefix = locatorPrefix ? String(locatorPrefix) : null;
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const seedIds = [...new Set(seedNodeIds)].filter((id) => nodeById.has(id)).sort();
  const initialIds = new Set(seedIds);
  if (prefix) {
    for (const node of [...graph.nodes].sort(byId)) {
      if (['file', 'symbol'].includes(node.kind) && node.locator?.startsWith(prefix)) initialIds.add(node.id);
    }
  }
  if (!initialIds.size) return emptyFocus(boundedNodeLimit, boundedEdgeLimit);

  const eligibleEdges = graph.edges
    .filter((edge) => initialIds.has(edge.fromNodeId) || initialIds.has(edge.toNodeId))
    .filter((edge) => endpointAllowed(nodeById.get(edge.fromNodeId), prefix) && endpointAllowed(nodeById.get(edge.toNodeId), prefix))
    .sort((left, right) => focusEdgeRank(left.kind) - focusEdgeRank(right.kind) || left.id.localeCompare(right.id));
  const eligibleNodeIds = new Set(initialIds);
  for (const edge of eligibleEdges) {
    eligibleNodeIds.add(edge.fromNodeId);
    eligibleNodeIds.add(edge.toNodeId);
  }

  const selectedNodeIds = new Set([...initialIds].slice(0, boundedNodeLimit));
  const selectedEdges = [];
  for (const edge of eligibleEdges) {
    if (selectedEdges.length >= boundedEdgeLimit) break;
    const missing = [edge.fromNodeId, edge.toNodeId].filter((id) => !selectedNodeIds.has(id));
    if (selectedNodeIds.size + missing.length > boundedNodeLimit) continue;
    for (const id of missing) selectedNodeIds.add(id);
    selectedEdges.push(edge);
  }
  const selectedNodes = [...selectedNodeIds].map((id) => nodeById.get(id)).filter(Boolean).sort(byId);

  return Object.freeze({
    nodeLimit: boundedNodeLimit,
    edgeLimit: boundedEdgeLimit,
    nodes: Object.freeze(selectedNodes),
    edges: Object.freeze(selectedEdges.sort(byId)),
    omittedNodes: Math.max(0, eligibleNodeIds.size - selectedNodes.length),
    omittedEdges: Math.max(0, eligibleEdges.length - selectedEdges.length)
  });
}

function groupPrefix(locator) {
  const parts = relativeLocator(locator).split('/').filter(Boolean);
  if (!parts.length) return null;
  if (parts[0] === 'providers') return parts.slice(0, Math.min(3, Math.max(1, parts.length - 1))).join('/');
  if (GROUP_ROOTS.has(parts[0])) return parts.slice(0, Math.min(2, Math.max(1, parts.length - 1))).join('/');
  return parts[0];
}

function relativeLocator(locator) {
  const value = String(locator ?? '').split('#', 1)[0];
  return value.startsWith('workspace://') ? value.slice('workspace://'.length) : '';
}

function fileLocator(locator) {
  const relative = relativeLocator(locator);
  return relative ? `workspace://${relative}` : null;
}

function compactEntryPoint(entryPoint) {
  return Object.fromEntries(Object.entries({
    nodeId: entryPoint.nodeId,
    label: entryPoint.label,
    qualifiedLabel: entryPoint.qualifiedLabel,
    locator: entryPoint.locator,
    symbolKind: entryPoint.symbolKind
  }).filter(([, value]) => value !== undefined && value !== null));
}

function endpointAllowed(node, locatorPrefix) {
  if (!node) return false;
  return !locatorPrefix || !node.locator || node.locator.startsWith(locatorPrefix);
}

function focusEdgeRank(kind) {
  const rank = FOCUS_EDGE_ORDER.indexOf(kind);
  return rank === -1 ? FOCUS_EDGE_ORDER.length : rank;
}

function stableId(prefix, value) {
  return `${prefix}_${hashRef(value).slice('sha256:'.length, 'sha256:'.length + 24)}`;
}

function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name}:invalid`);
  return value;
}

function byId(left, right) {
  return left.id.localeCompare(right.id);
}

function assertGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('source graph is required');
}

function emptyFocus(nodeLimit, edgeLimit) {
  return Object.freeze({
    nodeLimit,
    edgeLimit,
    nodes: Object.freeze([]),
    edges: Object.freeze([]),
    omittedNodes: 0,
    omittedEdges: 0
  });
}
