export function createGraphViewport(canvas, outline, inspector, {
  nodes = [],
  edges = [],
  onSelect = () => {},
  onError = () => {}
} = {}) {
  if (!canvas) return inertViewport();
  if (nodes.length > 200 || edges.length > 400) {
    onError('graph_layout_bounds_exceeded');
    return inertViewport();
  }

  const worker = new Worker(new URL('./graph-layout-worker.js', import.meta.url), { type: 'module' });
  const controller = new AbortController();
  const signal = controller.signal;
  const context = canvas.getContext('2d');
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  let positions = {};
  let bounds = null;
  let requestId = 0;
  let selectedNodeId = outline?.querySelector('[data-node-id][aria-current="true"]')?.dataset.nodeId ?? nodes[0]?.id ?? null;
  let scale = 1;
  let panX = 0;
  let panY = 0;
  let pointer = null;

  const resizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => requestLayout())
    : null;
  resizeObserver?.observe(canvas);
  if (!resizeObserver && typeof window !== 'undefined') window.addEventListener('resize', requestLayout, { signal });

  worker.addEventListener('message', ({ data }) => {
    if (data?.requestId !== requestId) return;
    if (data.error) {
      onError(data.error);
      return;
    }
    positions = data.positions ?? {};
    bounds = data.bounds ?? null;
    canvas.dataset.layoutReady = 'true';
    reset();
  }, { signal });
  worker.addEventListener('error', () => onError('graph_layout_worker_failed'), { signal });

  outline?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-node-id]');
    if (!button) return;
    select(button.dataset.nodeId, { focusView: true });
  }, { signal });
  canvas.addEventListener('pointerdown', (event) => {
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    canvas.setPointerCapture?.(event.pointerId);
  }, { signal });
  canvas.addEventListener('pointermove', (event) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) pointer.moved = true;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    panX += dx;
    panY += dy;
    draw();
  }, { signal });
  canvas.addEventListener('pointerup', (event) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    if (!pointer.moved) {
      const nodeId = hitTest(event);
      if (nodeId) select(nodeId);
    }
    pointer = null;
    canvas.releasePointerCapture?.(event.pointerId);
  }, { signal });
  canvas.addEventListener('pointercancel', () => { pointer = null; }, { signal });
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const anchorX = event.clientX - rect.left;
    const anchorY = event.clientY - rect.top;
    const nextScale = clamp(scale * Math.exp(-event.deltaY * 0.0015), 0.5, 2.5);
    const graphX = (anchorX - panX) / scale;
    const graphY = (anchorY - panY) / scale;
    scale = nextScale;
    panX = anchorX - graphX * scale;
    panY = anchorY - graphY * scale;
    draw();
  }, { passive: false, signal });

  const stage = canvas.closest('.source-map-stage');
  stage?.querySelector('[data-graph-action="fit"]')?.addEventListener('click', () => fit(), { signal });
  stage?.querySelector('[data-graph-action="reset"]')?.addEventListener('click', () => reset(), { signal });

  if (selectedNodeId) select(selectedNodeId);
  requestLayout();

  function requestLayout() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(320, Math.round(rect.width || canvas.width || 960));
    const height = Math.max(280, Math.round(rect.height || canvas.height || 560));
    syncCanvas(width, height);
    requestId += 1;
    worker.postMessage({ requestId, nodes, edges, width, height });
  }

  function syncCanvas(width, height) {
    const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.dataset.pixelRatio = String(ratio);
    draw();
  }

  function select(nodeId, { focusView = false } = {}) {
    if (!nodeById.has(nodeId)) return;
    selectedNodeId = nodeId;
    outline?.querySelectorAll('[data-node-id]').forEach((button) => {
      if (button.dataset.nodeId === nodeId) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    });
    if (inspector) inspector.dataset.selectedNodeId = nodeId;
    onSelect(nodeById.get(nodeId));
    if (focusView) focus(nodeId);
    else draw();
  }

  function focus(nodeId = selectedNodeId) {
    const point = positions[nodeId];
    if (!point) return;
    const { width, height } = cssSize();
    scale = Math.max(1, scale);
    panX = width / 2 - point.x * scale;
    panY = height / 2 - point.y * scale;
    draw();
  }

  function fit() {
    if (selectedNodeId && positions[selectedNodeId]) {
      scale = 1.35;
      focus(selectedNodeId);
      return;
    }
    fitBounds();
  }

  function fitBounds() {
    if (!bounds) return reset();
    const { width, height } = cssSize();
    const graphWidth = Math.max(1, bounds.maxX - bounds.minX);
    const graphHeight = Math.max(1, bounds.maxY - bounds.minY);
    scale = clamp(Math.min((width - 48) / graphWidth, (height - 48) / graphHeight), 0.5, 2.5);
    panX = (width - (bounds.minX + bounds.maxX) * scale) / 2;
    panY = (height - (bounds.minY + bounds.maxY) * scale) / 2;
    draw();
  }

  function reset() {
    scale = 1;
    panX = 0;
    panY = 0;
    draw();
  }

  function draw() {
    if (!context) return;
    const ratio = Number(canvas.dataset.pixelRatio) || 1;
    const { width, height } = cssSize();
    const palette = graphPalette(canvas);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = palette.panel;
    context.fillRect(0, 0, width, height);
    context.save();
    context.translate(panX, panY);
    context.scale(scale, scale);
    context.lineWidth = 1 / scale;
    context.strokeStyle = palette.rule;
    for (const edge of edges) {
      const from = positions[edge.fromNodeId];
      const to = positions[edge.toNodeId];
      if (!from || !to) continue;
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
    }
    context.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.textBaseline = 'middle';
    for (const node of nodes) {
      const point = positions[node.id];
      if (!point) continue;
      const selected = node.id === selectedNodeId;
      context.fillStyle = selected ? palette.accent : palette.ink;
      context.beginPath();
      context.arc(point.x, point.y, selected ? 6 : 4, 0, Math.PI * 2);
      context.fill();
      if (selected || nodes.length <= 60) {
        const label = String(node.label ?? '').slice(0, 32);
        const placement = graphLabelPlacement({
          pointX: point.x,
          labelWidth: context.measureText(label).width,
          scale,
          panX,
          viewportWidth: width
        });
        context.fillStyle = palette.ink;
        context.textAlign = placement.align;
        context.fillText(label, point.x + placement.offset, point.y);
      }
    }
    context.restore();
  }

  function hitTest(event) {
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) - panX) / scale;
    const y = ((event.clientY - rect.top) - panY) / scale;
    let selected = null;
    let distance = 12 / scale;
    for (const node of nodes) {
      const point = positions[node.id];
      if (!point) continue;
      const candidate = Math.hypot(point.x - x, point.y - y);
      if (candidate <= distance) {
        selected = node.id;
        distance = candidate;
      }
    }
    return selected;
  }

  function cssSize() {
    const ratio = Number(canvas.dataset.pixelRatio) || 1;
    return { width: canvas.width / ratio, height: canvas.height / ratio };
  }

  return {
    fit,
    reset,
    focus,
    destroy() {
      controller.abort();
      resizeObserver?.disconnect();
      worker.terminate();
    }
  };
}

export function graphLabelPlacement({ pointX = 0, labelWidth = 0, scale = 1, panX = 0, viewportWidth = 0 } = {}) {
  const resolvedScale = Math.max(0.01, Number(scale) || 1);
  const screenX = Number(panX) + Number(pointX) * resolvedScale;
  const scaledLabelWidth = Math.max(0, Number(labelWidth) || 0) * resolvedScale;
  const rightEdge = screenX + (10 * resolvedScale) + scaledLabelWidth;
  const leftEdge = screenX - (10 * resolvedScale) - scaledLabelWidth;
  return rightEdge > Number(viewportWidth) - 8 && leftEdge >= 8
    ? { align: 'right', offset: -10 }
    : { align: 'left', offset: 10 };
}

function graphPalette(canvas) {
  const styles = getComputedStyle(canvas);
  const token = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
  return {
    panel: token('--color-panel', '#ffffff'),
    rule: token('--color-rule-strong', '#a7a7a7'),
    ink: token('--color-ink', '#202020'),
    accent: token('--color-accent', '#345cff')
  };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function inertViewport() {
  return { fit() {}, reset() {}, focus() {}, destroy() {} };
}
