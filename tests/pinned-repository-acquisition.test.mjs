import assert from 'node:assert/strict';
import test from 'node:test';
import {
  codeloadCurlArgs,
  codeloadProvenance,
  contentsCurlArgs,
  contentsUrl,
  gitBlobSha,
  normalizeScope,
  provenanceMatches,
  scopeProvenance,
  validateScopeCoordinates,
  validateScopeEntry,
  validateScopeManifest,
  validateArchivePaths,
  validateCodeloadCoordinates
} from '../scripts/pinned-repository-acquisition.mjs';

test('pinned repository acquisition validates exact pins, safe paths, and explicit provenance', () => {
  const commit = 'c9f3fd55854a743b66f857ace3c7b268ea3e2ef7';
  assert.deepEqual(validateCodeloadCoordinates({ id: 'gson', url: 'https://github.com/google/gson.git', commit }), {
    owner: 'google', repo: 'gson', url: `https://codeload.github.com/google/gson/tar.gz/${commit}`
  });
  assert.throws(() => validateCodeloadCoordinates({ id: 'bad', url: 'https://example.com/google/gson.git', commit }), /codeload_pin_invalid/u);
  assert.throws(() => validateCodeloadCoordinates({ id: 'bad', url: 'https://github.com/google/gson.git', commit: 'main' }), /codeload_pin_invalid/u);
  assert.equal(validateArchivePaths(['gson-pin/', 'gson-pin/src/Main.java']), true);
  assert.throws(() => validateArchivePaths(['gson-pin/../escape']), /codeload_unsafe_archive_path/u);
  assert.throws(() => validateArchivePaths(['/absolute']), /codeload_unsafe_archive_path/u);
  assert.deepEqual(codeloadProvenance(commit, 'src'), { acquisitionKind: 'codeload-exact-commit', commit, scope: 'src' });
  assert.equal(provenanceMatches(codeloadProvenance(commit, 'src'), commit, 'src'), true);
  assert.equal(provenanceMatches(codeloadProvenance(commit, 'src'), commit, 'other'), false);
  const args = codeloadCurlArgs(`https://codeload.github.com/google/gson/tar.gz/${commit}`, '/tmp/source.tar.gz');
  assert.deepEqual(args.slice(0, 6), ['--fail', '--silent', '--show-error', '--proto', '=https', '--max-redirs']);
  assert.equal(args[6], '0');
  assert.equal(args[args.indexOf('--max-time') + 1], '60');
  assert.equal(args[args.indexOf('--max-filesize') + 1], String(128 * 1024 * 1024));
  assert.throws(() => codeloadCurlArgs('https://example.com/archive', '/tmp/source.tar.gz'), /codeload_url_invalid/u);
  const scoped = validateScopeCoordinates({ id: 'gson', url: 'https://github.com/google/gson.git', commit }, 'src/main/java');
  assert.equal(contentsUrl(scoped, scoped.scope), `https://api.github.com/repos/google/gson/contents/src/main/java?ref=${commit}`);
  assert.throws(() => normalizeScope('../escape'), /github_scope_path_invalid/u);
  const bytes = Buffer.from('class Main {}\n');
  const download = `https://raw.githubusercontent.com/google/gson/${commit}/src/main/java/Main.java`;
  const entry = { type: 'file', path: 'src/main/java/Main.java', size: bytes.length, sha: gitBlobSha(bytes), download_url: download };
  assert.equal(validateScopeEntry(entry, scoped), entry.path);
  assert.equal(validateScopeManifest([{ path: entry.path, size: entry.size, sha: entry.sha, url: download }], scoped), true);
  assert.throws(() => validateScopeEntry({ ...entry, type: 'symlink' }, scoped), /github_scope_entry_type_unsupported/u);
  assert.throws(() => validateScopeEntry({ ...entry, path: 'outside/Main.java' }, scoped), /github_scope_entry_outside_scope/u);
  assert.deepEqual(scopeProvenance(commit, scoped.scope), { acquisitionKind: 'github-contents-exact-scope', commit, scope: scoped.scope });
  assert.equal(provenanceMatches(scopeProvenance(commit, scoped.scope), commit, scoped.scope), true);
  const apiArgs = contentsCurlArgs(contentsUrl(scoped, scoped.scope), '/tmp/list.json', 9);
  assert.equal(apiArgs[apiArgs.indexOf('--max-time') + 1], '9');
  assert.throws(() => contentsCurlArgs('https://example.com/list', '/tmp/list.json'), /github_scope_url_invalid/u);
});
