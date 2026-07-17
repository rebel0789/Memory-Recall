import assert from 'node:assert/strict';
import test from 'node:test';
import { uniqueRepositoryCount } from '../scripts/code-intelligence-case-counts.mjs';

test('additional scopes from one pinned repository count as one repository', () => {
  assert.equal(uniqueRepositoryCount([
    { id: 'base', repositoryId: 'repo_a', sourceClass: 'real-repo' },
    { id: 'extra', repositoryId: 'repo_a', sourceClass: 'real-repo' },
    { id: 'other', repositoryId: 'repo_b', sourceClass: 'real-repo' },
    { id: 'fixture', sourceClass: 'fixture' }
  ]), 2);
});
