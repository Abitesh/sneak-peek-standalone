import assert from 'node:assert/strict';
import test from 'node:test';

const flags = await import(new URL('../../../dist-electron/electron/intelligence/intelligenceFlags.js', import.meta.url).href);

const { intelligenceFlagMeta, isIntelligenceFlagEnabled, shouldWriteLegacyRagChunks, __resetIntelligenceFlagsCache } = flags;
const READ_ENV = 'NATIVELY_CANONICAL_RAG_READ';
const SHADOW_ENV = 'NATIVELY_CANONICAL_RAG_SHADOW';
const ORIGINAL_ENV = new Map([
  [READ_ENV, process.env[READ_ENV]],
  [SHADOW_ENV, process.env[SHADOW_ENV]],
]);

function clearRagFlagEnv() {
  delete process.env[READ_ENV];
  delete process.env[SHADOW_ENV];
  __resetIntelligenceFlagsCache();
}

function restoreRagFlagEnv() {
  for (const [key, value] of ORIGINAL_ENV) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __resetIntelligenceFlagsCache();
}

test.beforeEach(clearRagFlagEnv);
test.afterEach(restoreRagFlagEnv);

test('canonicalRagRead is registered with the required fail-closed contract', () => {
  assert.deepEqual(intelligenceFlagMeta('canonicalRagRead'), {
    env: READ_ENV,
    setting: 'canonicalRagReadEnabled',
    default: false,
  });
  assert.equal(isIntelligenceFlagEnabled('canonicalRagRead'), false);
});

test('canonicalRagRead can be enabled independently through its environment override', () => {
  process.env[READ_ENV] = 'on';
  __resetIntelligenceFlagsCache();
  assert.equal(isIntelligenceFlagEnabled('canonicalRagRead'), true);
  assert.equal(isIntelligenceFlagEnabled('canonicalRagShadow'), false);
});

test('canonicalRagShadow does not enable canonicalRagRead', () => {
  process.env[SHADOW_ENV] = 'on';
  __resetIntelligenceFlagsCache();
  assert.equal(isIntelligenceFlagEnabled('canonicalRagShadow'), true);
  assert.equal(isIntelligenceFlagEnabled('canonicalRagRead'), false);
});

test('canonicalRagRead environment state is isolated between tests', () => {
  assert.equal(isIntelligenceFlagEnabled('canonicalRagRead'), false);
  assert.equal(isIntelligenceFlagEnabled('canonicalRagShadow'), false);
});

test('legacy RAG chunk writes stay on until canonical reads are authoritative', () => {
  assert.equal(shouldWriteLegacyRagChunks(), true);
  process.env[READ_ENV] = 'on';
  __resetIntelligenceFlagsCache();
  assert.equal(shouldWriteLegacyRagChunks(), false);
});
