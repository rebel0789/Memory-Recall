import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalStringify, stableStringify, sha256Hex, assertPlainObject } from '../packages/protocol/src/index.mjs';

function legacyCanonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => legacyCanonicalStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${legacyCanonicalStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function legacyNullFirstStableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(legacyNullFirstStableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${legacyNullFirstStableStringify(value[key])}`).join(',')}}`;
}

function legacyRawSha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('protocol fingerprint helpers preserve canonical and stable serialization', () => {
  const values = [
    { z: 1, a: ['x', { b: true, a: null }] },
    [{ b: 2, a: 1 }, undefined, 'text'],
    null,
    'plain'
  ];

  for (const value of values) {
    assert.equal(canonicalStringify(value), legacyCanonicalStringify(value));
    assert.equal(stableStringify(value), legacyCanonicalStringify(value));
    assert.equal(stableStringify(value), legacyNullFirstStableStringify(value));
  }
});

test('sha256Hex preserves raw hash.update behavior for string and non-string inputs', () => {
  for (const value of ['abc', Buffer.from([0, 1, 2, 255]), new Uint8Array([3, 4, 5])]) {
    assert.equal(sha256Hex(value), legacyRawSha256(value));
  }

  assert.throws(() => sha256Hex({ value: 'not accepted by raw hash.update' }), TypeError);
});

test('assertPlainObject variants remain local because validation outcomes differ', () => {
  assert.throws(() => assertPlainObject([], 'sample'), { name: 'TypeError', message: 'sample must be an object' });
  const toolStyleError = new Error('tool_request_invalid: sample must be an object');
  toolStyleError.code = 'tool_request_invalid';
  assert.notEqual(toolStyleError.name, 'TypeError');
});
