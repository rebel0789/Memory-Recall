export const CODE_INTELLIGENCE_INDEX_LOCATOR = 'workspace://.local/source-index/index.v1.sqlite';

export const CODE_INTELLIGENCE_INDEX_OPERATIONS = Object.freeze([
  'index.build',
  'index.refresh',
  'index.repair',
  'index.status',
  'index.doctor',
  'index.query'
]);

export const CODE_INTELLIGENCE_INDEX_QUERY_KINDS = Object.freeze([
  'summary',
  'exact',
  'search',
  'neighborhood',
  'dependencies',
  'trace',
  'impact',
  'routes'
]);
