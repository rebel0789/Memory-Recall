import test from 'node:test';
import assert from 'node:assert/strict';
import { CandidateSourcePort, CodeIntelligencePort, ContractViolation, MemoryBackendPort, ModelGatewayPort, assertCanonicalEnvelope, assertPortImplementation, createProviderEnvelope, normalizeCapabilities, normalizeHealthResult } from '../packages/adapter-contracts/src/index.mjs';

test('port implementation check reports exact missing methods', () => {
  assert.throws(
    () => assertPortImplementation({ health() {} }, MemoryBackendPort),
    (error) => error instanceof ContractViolation && error.code === 'missing_methods' && error.details.missing.includes('queryCandidates')
  );
});

test('candidate source port uses descriptor health query shape', () => {
  assert.deepEqual(CandidateSourcePort.requiredMethods, ['descriptor', 'health', 'query']);
  assert.doesNotThrow(() => assertPortImplementation({
    descriptor() {},
    health() {},
    query() {}
  }, CandidateSourcePort));
});

test('code intelligence port keeps native process details behind one graph method', () => {
  assert.deepEqual(CodeIntelligencePort.requiredMethods, ['health', 'capabilities', 'buildGraph']);
  assert.doesNotThrow(() => assertPortImplementation({
    health() {},
    capabilities() {},
    buildGraph() {}
  }, CodeIntelligencePort));
});

test('model gateway port exposes provider profile before generation', () => {
  assert.deepEqual(ModelGatewayPort.requiredMethods, ['health', 'capabilities', 'profile', 'generate']);
  assert.doesNotThrow(() => assertPortImplementation({
    health() {},
    capabilities() {},
    profile() {},
    generate() {}
  }, ModelGatewayPort));
});

test('health and capabilities normalize provider output', () => {
  const health = normalizeHealthResult({ status: 'healthy', details: { ok: true } }, 'provider:test');
  assert.equal(health.providerId, 'provider:test');
  assert.deepEqual(normalizeCapabilities(['b', 'a', 'a'], 'provider:test'), ['a', 'b']);
  assert.throws(() => normalizeHealthResult({ status: 'unknown' }, 'provider:test'), /unsupported/);
});

test('provider envelopes preserve identity and reject mismatches', () => {
  const envelope = createProviderEnvelope({ providerId: 'provider:test', operation: 'read', payload: { id: 'one' } });
  assert.equal(assertCanonicalEnvelope(envelope, 'provider:test').payload.id, 'one');
  assert.throws(() => assertCanonicalEnvelope(envelope, 'provider:other'), /expected provider:other/);
});
