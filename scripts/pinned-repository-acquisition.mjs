import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const MAX_BYTES = 128 * 1024 * 1024;
const GIT_TIMEOUT = 15_000;
const COMMAND_TIMEOUT = 60_000;
const CODELOAD_COMMAND_TIMEOUT = 65_000;
const SCOPE_TIMEOUT = 60_000;
const MAX_SCOPE_DIRECTORIES = 128;
const MAX_SCOPE_FILES = 5_000;
const MAX_SCOPE_FILE_BYTES = 16 * 1024 * 1024;
const SCOPE_CONCURRENCY = 6;

export async function acquirePinnedRepository(repository, { scope = '.', checkoutId = repository.id, lower = 'batch' } = {}) {
  const cache = path.join(os.tmpdir(), 'memory-recall-code-intelligence-corpus-v1', checkoutId);
  const receipt = `${cache}.acquisition.json`;
  const cached = await cachedAcquisition({ cache, receipt, commit: repository.commit, scope });
  if (cached) {
    return { directory: cache, acquisitionKind: cached.acquisitionKind, commit: repository.commit };
  }
  await mkdir(cache, { recursive: true });
  try {
    await gitAcquire(cache, repository, scope, lower);
    return { directory: cache, acquisitionKind: 'git-exact-commit', commit: repository.commit };
  } catch (gitError) {
    let scopeError;
    if (scope !== '.') {
      try {
        await githubScopeAcquire(cache, repository, scope);
        return { directory: cache, acquisitionKind: 'github-contents-exact-scope', commit: repository.commit, gitError: errorText(gitError) };
      } catch (error) { scopeError = error; }
    }
    try {
      await codeloadAcquire(cache, repository, scope);
      return { directory: cache, acquisitionKind: 'codeload-exact-commit', commit: repository.commit, gitError: errorText(gitError), ...(scopeError ? { scopeError: errorText(scopeError) } : {}) };
    } catch (codeloadError) {
      throw new Error(`pinned_acquisition_failed:${repository.id}:git=${errorText(gitError)}:scope=${errorText(scopeError)}:codeload=${errorText(codeloadError)}`, { cause: codeloadError });
    }
  }
}

async function gitAcquire(directory, repository, scope, lower) {
  if (!(await exists(path.join(directory, '.git')))) {
    await run('git', ['init', '--quiet'], directory);
    await run('git', ['remote', 'add', 'origin', repository.url], directory);
  }
  if (scope === '.') await run('git', ['sparse-checkout', 'disable'], directory);
  else {
    await run('git', ['sparse-checkout', 'init', '--cone'], directory);
    await run('git', ['sparse-checkout', 'set', scope], directory);
  }
  try { await run('git', ['cat-file', '-e', `${repository.commit}^{commit}`], directory); }
  catch { await run('git', ['fetch', '--quiet', '--depth', '1', '--filter=blob:none', '--no-tags', 'origin', repository.commit], directory, GIT_TIMEOUT); }
  await run('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', repository.commit], directory);
  if ((await run('git', ['rev-parse', 'HEAD'], directory)) !== repository.commit) throw new Error(`batch_${lower}_repository_commit_mismatch:${repository.id}`);
  if (await run('git', ['status', '--porcelain=v1', '--untracked-files=all'], directory)) throw new Error(`batch_${lower}_repository_dirty:${repository.id}`);
}

async function codeloadAcquire(cache, repository, scope) {
  const coordinates = validateCodeloadCoordinates(repository);
  const temp = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-codeload-'));
  try {
    const archive = path.join(temp, 'source.tar.gz');
    try {
      await run(process.platform === 'win32' ? 'curl.exe' : 'curl', codeloadCurlArgs(coordinates.url, archive), temp, CODELOAD_COMMAND_TIMEOUT);
    } catch (error) {
      const downloadedBytes = await fileSize(archive);
      throw new Error(`codeload_download_failed:${repository.id}:${downloadedBytes}:${error.code ?? error.name ?? 'Error'}`, { cause: error });
    }
    const archiveBytes = await fileSize(archive);
    if (archiveBytes <= 0 || archiveBytes > MAX_BYTES) throw new Error(`codeload_archive_size_invalid:${repository.id}:${archiveBytes}`);
    const listing = (await run('tar', ['-tzf', archive], temp)).split('\n').filter(Boolean);
    validateArchivePaths(listing);
    await run('tar', ['-xzf', archive, '-C', temp], temp);
    const [root] = listing[0].split('/');
    const extracted = path.join(temp, root);
    const target = scope === '.' ? extracted : path.join(extracted, scope);
    await rm(cache, { recursive: true, force: true });
    await rename(extracted, cache);
    await writeFile(`${cache}.acquisition.json`, JSON.stringify(codeloadProvenance(repository.commit, scope), null, 2));
    if (!(await exists(target === cache ? cache : path.join(cache, scope)))) throw new Error('codeload_scope_missing');
  } finally { await rm(temp, { recursive: true, force: true }); }
}

async function githubScopeAcquire(cache, repository, scope) {
  const coordinates = validateScopeCoordinates(repository, scope);
  const deadline = Date.now() + SCOPE_TIMEOUT;
  const directories = [coordinates.scope];
  const files = [];
  for (let cursor = 0; cursor < directories.length; cursor++) {
    if (directories.length > MAX_SCOPE_DIRECTORIES) throw new Error('github_scope_directory_limit');
    const relative = directories[cursor];
    const temp = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-contents-list-'));
    try {
      const output = path.join(temp, 'contents.json');
      await boundedCurl(contentsCurlArgs(contentsUrl(coordinates, relative), output, secondsRemaining(deadline)), temp, deadline);
      const entries = JSON.parse(await readFile(output, 'utf8'));
      if (!Array.isArray(entries)) throw new Error('github_scope_listing_invalid');
      for (const entry of entries) {
        const safePath = validateScopeEntry(entry, coordinates);
        if (entry.type === 'dir') directories.push(safePath);
        else {
          files.push({ path: safePath, size: entry.size, sha: entry.sha, url: entry.download_url });
          if (files.length > MAX_SCOPE_FILES) throw new Error('github_scope_file_limit');
        }
      }
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  validateScopeManifest(files, coordinates);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_BYTES) throw new Error(`github_scope_bytes_limit:${totalBytes}`);
  const temp = await mkdtemp(path.join(os.tmpdir(), 'memory-recall-contents-'));
  const root = path.join(temp, 'root');
  try {
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(SCOPE_CONCURRENCY, files.length) }, async () => {
      while (cursor < files.length) {
        const file = files[cursor++];
        const target = path.join(root, file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await boundedCurl(contentsCurlArgs(file.url, target, secondsRemaining(deadline)), temp, deadline);
        const bytes = await readFile(target);
        if (bytes.length !== file.size || gitBlobSha(bytes) !== file.sha) throw new Error(`github_scope_blob_mismatch:${file.path}`);
      }
    }));
    await rm(cache, { recursive: true, force: true });
    await rename(root, cache);
    await writeFile(`${cache}.acquisition.json`, JSON.stringify(scopeProvenance(repository.commit, coordinates.scope), null, 2));
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export function validateCodeloadCoordinates(repository) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(repository.url);
  if (!match || !/^[0-9a-f]{40}$/u.test(repository.commit)) throw new Error(`codeload_pin_invalid:${repository.id}`);
  return { owner: match[1], repo: match[2], url: `https://codeload.github.com/${match[1]}/${match[2]}/tar.gz/${repository.commit}` };
}

export function validateArchivePaths(listing) {
  if (!Array.isArray(listing) || listing.length === 0 || listing.some((entry) => entry.startsWith('/') || entry.split('/').includes('..'))) {
    throw new Error('codeload_unsafe_archive_path');
  }
  return true;
}

export function codeloadProvenance(commit, scope) {
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('codeload_pin_invalid');
  return { acquisitionKind: 'codeload-exact-commit', commit, scope };
}

export function provenanceMatches(value, commit, scope) {
  return ['codeload-exact-commit', 'github-contents-exact-scope'].includes(value?.acquisitionKind)
    && value.commit === commit
    && value.scope === scope;
}

export function normalizeScope(scope) {
  if (typeof scope !== 'string' || scope === '' || scope === '.' || scope.startsWith('/') || scope.includes('\\')) throw new Error('github_scope_path_invalid');
  const normalized = path.posix.normalize(scope);
  if (normalized !== scope || normalized.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('github_scope_path_invalid');
  return normalized;
}

export function validateScopeCoordinates(repository, scope) {
  const origin = validateCodeloadCoordinates(repository);
  return { owner: origin.owner, repo: origin.repo, commit: repository.commit, scope: normalizeScope(scope) };
}

export function validateScopeEntry(entry, coordinates) {
  if (!entry || !['file', 'dir'].includes(entry.type)) throw new Error('github_scope_entry_type_unsupported');
  const safePath = normalizeScope(entry.path);
  if (!(safePath === coordinates.scope || safePath.startsWith(`${coordinates.scope}/`))) throw new Error('github_scope_entry_outside_scope');
  if (entry.type === 'file') {
    if (!Number.isInteger(entry.size) || entry.size < 0 || entry.size > MAX_SCOPE_FILE_BYTES || !/^[0-9a-f]{40}$/u.test(entry.sha)) throw new Error('github_scope_file_invalid');
    validateRawUrl(entry.download_url, coordinates, safePath);
  }
  return safePath;
}

export function validateScopeManifest(files, coordinates) {
  const seen = new Set();
  for (const file of files) {
    validateScopeEntry({ type: 'file', path: file.path, size: file.size, sha: file.sha, download_url: file.url }, coordinates);
    if (seen.has(file.path)) throw new Error('github_scope_duplicate_path');
    seen.add(file.path);
  }
  return true;
}

export function scopeProvenance(commit, scope) {
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('github_scope_pin_invalid');
  return { acquisitionKind: 'github-contents-exact-scope', commit, scope: normalizeScope(scope) };
}

export function gitBlobSha(bytes) { return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); }

export function contentsUrl(coordinates, relative) {
  const encoded = normalizeScope(relative).split('/').map(encodeURIComponent).join('/');
  return `https://api.github.com/repos/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.repo)}/contents/${encoded}?ref=${coordinates.commit}`;
}

export function contentsCurlArgs(url, output, maxSeconds = 60) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['api.github.com', 'raw.githubusercontent.com'].includes(parsed.hostname)) throw new Error('github_scope_url_invalid');
  return ['--fail', '--silent', '--show-error', '--proto', '=https', '--max-redirs', '0', '--connect-timeout', '15', '--max-time', String(maxSeconds), '--max-filesize', String(MAX_SCOPE_FILE_BYTES), '--header', 'Accept: application/vnd.github+json', '--header', 'User-Agent: memory-recall-language-gate', '--output', output, url];
}

export function codeloadCurlArgs(url, output) {
  if (!url.startsWith('https://codeload.github.com/')) throw new Error('codeload_url_invalid');
  return [
    '--fail', '--silent', '--show-error',
    '--proto', '=https', '--max-redirs', '0',
    '--connect-timeout', '15', '--max-time', '60',
    '--max-filesize', String(MAX_BYTES),
    '--output', output,
    url
  ];
}

async function run(file, args, cwd, timeout = COMMAND_TIMEOUT) { return String((await exec(file, args, { cwd, timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })).stdout).trim(); }
async function exists(file) { try { await stat(file); return true; } catch { return false; } }
async function fileSize(file) { try { return (await stat(file)).size; } catch { return 0; } }
async function cachedAcquisition({ cache, receipt, commit, scope }) {
  if (!(await exists(cache)) || !(await exists(scope === '.' ? cache : path.join(cache, scope)))) return false;
  try { const value = JSON.parse(await readFile(receipt, 'utf8')); return provenanceMatches(value, commit, scope) ? value : false; } catch { return false; }
}
function secondsRemaining(deadline) { const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error('github_scope_deadline'); return Math.max(1, Math.ceil(remaining / 1000)); }
async function boundedCurl(args, cwd, deadline) { await run(process.platform === 'win32' ? 'curl.exe' : 'curl', args, cwd, Math.max(1_000, deadline - Date.now() + 1_000)); }
function validateRawUrl(value, coordinates, relative) { const url = new URL(value); const expected = `/${[coordinates.owner, coordinates.repo, coordinates.commit, ...relative.split('/')].map(encodeURIComponent).join('/')}`; if (url.protocol !== 'https:' || url.hostname !== 'raw.githubusercontent.com' || url.pathname !== expected) throw new Error('github_scope_download_url_invalid'); }
function errorText(error) { return error ? String(error.message ?? error).replaceAll(':', '_') : 'not-applicable'; }
