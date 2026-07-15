export const PRIMARY_NAV = Object.freeze([
  { id: 'overview', routeId: 'home', path: '/', label: 'Overview' },
  { id: 'map', routeId: 'source-graph', path: '/map', label: 'Map' },
  { id: 'memory', routeId: 'memory', path: '/memory', label: 'Memory' },
  { id: 'handoffs', routeId: 'context-pack', path: '/handoffs', label: 'Handoffs' },
  { id: 'settings', routeId: 'settings', path: '/settings', label: 'Settings' }
]);

export const MOBILE_NAV = Object.freeze(PRIMARY_NAV.filter((item) => item.id !== 'settings'));

const ROUTE_OWNERS = new Map([
  ['home', 'overview'],
  ['runs', 'overview'],
  ['workflows', 'overview'],
  ['loop-workbench', 'overview'],
  ['fabric-map', 'overview'],
  ['source-graph', 'map'],
  ['memory', 'memory'],
  ['memory-graph', 'memory'],
  ['context-pack', 'handoffs'],
  ['context', 'handoffs'],
  ['evidence', 'memory'],
  ['approvals', 'memory'],
  ['content', 'overview'],
  ['agents', 'settings'],
  ['settings', 'settings']
]);

export function navigationOwner(routeId) {
  return ROUTE_OWNERS.get(String(routeId ?? '')) ?? 'overview';
}

export function navigationItemsFor(mode) {
  return mode === 'bottom' ? MOBILE_NAV : PRIMARY_NAV;
}

export function selectOverviewPrimaryAction(model = {}) {
  if (model.state === 'loading' || model.state === 'error' || model.state === 'failure') return null;
  if (model.state === 'empty') return { label: 'Scan repository', route: '/', action: 'refresh-recall-map' };
  const pendingCount = Number(model.trust?.memory?.pendingCount ?? model.memory?.pendingCount ?? 0);
  if (pendingCount > 0) return { label: `Review ${pendingCount} proposal${pendingCount === 1 ? '' : 's'}`, route: '/memory', routeId: 'memory' };
  const handoffState = model.trust?.handoff?.state ?? model.handoff?.state;
  if (handoffState === 'blocked') return { label: 'Repair handoff', route: '/handoffs', routeId: 'context-pack' };
  if (model.state === 'stale' || handoffState === 'review') return { label: 'Update handoff', route: '/handoffs', routeId: 'context-pack' };
  if (handoffState === 'ready') return { label: 'View current handoff', route: '/handoffs', routeId: 'context-pack' };
  return null;
}
