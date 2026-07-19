export function uniqueRepositoryCount(cases) {
  return new Set(cases
    .filter((item) => item.sourceClass === 'real-repo')
    .map((item) => item.repositoryId ?? item.id)).size;
}
