import { createHash } from 'node:crypto';

export function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const stableStringify = canonicalStringify;

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}
