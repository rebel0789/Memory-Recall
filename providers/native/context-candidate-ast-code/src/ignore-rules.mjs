import { readFile } from 'node:fs/promises';
import path from 'node:path';

export function parseIgnoreFile(text, { base = '' } = {}) {
  const normalizedBase = base ? normalizeRelativePath(base) : '';
  return String(text ?? '').split(/\r?\n/u).flatMap((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return [];
    const negated = line.startsWith('!');
    const pattern = (negated ? line.slice(1) : line).replace(/\\([#!])/gu, '$1');
    if (!pattern) return [];
    return [{ base: normalizedBase, pattern, negated, directoryOnly: pattern.endsWith('/'), index }];
  });
}

export function isIgnoredPath(relativePath, { isDirectory = false, rules = [], explicitIncludes = [] } = {}) {
  const normalized = normalizeRelativePath(relativePath);
  const includes = explicitIncludes.map(normalizeRelativePath);
  if (includes.some((item) => item === normalized || item.startsWith(`${normalized}/`))) return false;
  let ignored = false;
  for (const rule of rules) {
    if (matchesIgnoreRule(normalized, isDirectory, rule)) ignored = !rule.negated;
  }
  return ignored;
}

export async function loadRootRecallIgnore(root) {
  return loadIgnoreFile(path.join(root, '.recallignore'), { base: '' });
}

export async function loadIgnoreFile(file, { base = '' } = {}) {
  try {
    return parseIgnoreFile(await readFile(file, 'utf8'), { base });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export function normalizeIgnoreRelativePath(value) {
  return normalizeRelativePath(value);
}

function normalizeRelativePath(value) {
  const raw = String(value ?? '');
  const normalized = raw.replace(/^\.\//u, '').replace(/\/$/u, '');
  if (!normalized || raw.includes('\\') || normalized.startsWith('/') || /(?:^|\/)\.\.(?:\/|$)/u.test(normalized) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(normalized)) {
    throw new Error('source_graph_explicit_include_invalid');
  }
  return normalized;
}

function matchesIgnoreRule(relativePath, isDirectory, rule) {
  const rawPattern = String(rule?.pattern ?? '').replace(/\/$/u, '');
  if (!rawPattern) return false;
  const anchored = rawPattern.startsWith('/');
  const pattern = anchored ? rawPattern.slice(1) : rawPattern;
  const base = rule.base ? normalizeRelativePath(rule.base) : '';
  const scoped = base ? `${base}/${pattern}` : pattern;

  if (rule.directoryOnly) {
    if (anchored || pattern.includes('/')) {
      return relativePath === scoped || relativePath.startsWith(`${scoped}/`);
    }
    const relativeToBase = base && relativePath.startsWith(`${base}/`) ? relativePath.slice(base.length + 1) : base ? '' : relativePath;
    if (!relativeToBase) return false;
    const segments = relativeToBase.split('/');
    const directorySegments = isDirectory ? segments : segments.slice(0, -1);
    return directorySegments.some((segment) => path.matchesGlob(segment, pattern));
  }

  const glob = anchored || pattern.includes('/')
    ? scoped
    : base ? `${base}/**/${pattern}` : `**/${pattern}`;
  return path.matchesGlob(relativePath, glob)
    || (!pattern.includes('/') && relativePath.startsWith(base ? `${base}/` : '') && path.matchesGlob(path.basename(relativePath), pattern));
}
