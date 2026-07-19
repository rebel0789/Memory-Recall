export function layoutFocusedGraph(nodes = [], edges = [], width = 960, height = 560) {
  if (nodes.length > 200 || edges.length > 400) throw new Error('graph_layout_bounds_exceeded');
  const ordered = [...nodes].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const adjacency = new Map(ordered.map(({ id }) => [id, new Set()]));
  for (const { fromNodeId, toNodeId } of edges) {
    if (!adjacency.has(fromNodeId) || !adjacency.has(toNodeId)) continue;
    adjacency.get(fromNodeId).add(toNodeId);
    adjacency.get(toNodeId).add(fromNodeId);
  }

  const roots = [...ordered].sort((left, right) => (
    adjacency.get(right.id).size - adjacency.get(left.id).size
    || String(left.id).localeCompare(String(right.id))
  ));
  const layerById = new Map();
  let componentOffset = 0;
  for (const root of roots) {
    if (layerById.has(root.id)) continue;
    const queue = [{ id: root.id, layer: componentOffset }];
    let cursor = 0;
    let componentMax = componentOffset;
    while (cursor < queue.length) {
      const current = queue[cursor++];
      if (layerById.has(current.id)) continue;
      layerById.set(current.id, current.layer);
      componentMax = Math.max(componentMax, current.layer);
      for (const neighbor of [...adjacency.get(current.id)].sort()) {
        if (!layerById.has(neighbor)) queue.push({ id: neighbor, layer: current.layer + 1 });
      }
    }
    componentOffset = componentMax + 2;
  }

  const layers = new Map();
  for (const node of ordered) {
    const layer = layerById.get(node.id) ?? 0;
    if (!layers.has(layer)) layers.set(layer, []);
    layers.get(layer).push(node.id);
  }
  const layerIds = [...layers.keys()].sort((left, right) => left - right);
  const safeWidth = Math.max(160, Number(width) || 960);
  const safeHeight = Math.max(160, Number(height) || 560);
  const xStep = (safeWidth - 96) / Math.max(1, layerIds.length - 1);
  const positions = {};
  layerIds.forEach((layer, column) => {
    const ids = layers.get(layer);
    const yStep = (safeHeight - 96) / Math.max(1, ids.length - 1);
    ids.forEach((id, row) => {
      positions[id] = {
        x: 48 + column * xStep,
        y: ids.length === 1 ? safeHeight / 2 : 48 + row * yStep
      };
    });
  });
  return {
    positions,
    bounds: { minX: 48, minY: 48, maxX: safeWidth - 48, maxY: safeHeight - 48 }
  };
}

if (typeof self !== 'undefined') {
  self.onmessage = ({ data }) => {
    const { requestId, nodes = [], edges = [], width = 960, height = 560 } = data ?? {};
    if (nodes.length > 200 || edges.length > 400) {
      self.postMessage({ requestId, error: 'graph_layout_bounds_exceeded' });
      return;
    }
    const { positions, bounds } = layoutFocusedGraph(nodes, edges, width, height);
    self.postMessage({ requestId, positions, bounds });
  };
}
