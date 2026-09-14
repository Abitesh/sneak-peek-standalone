// Change 25 Phase 6.3 — canonical lexical shadow service.
// The shadow is observe-only: it executes canonical lexical reads and records
// content-free diagnostics, while never touching embeddings or legacy results.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CanonicalRagShadowService } from '../../../dist-electron/electron/rag/canonical/CanonicalRagShadowService.js';

function makeStorage(overrides = {}) {
  const calls = [];
  return {
    calls,
    searchLexical(query, options) {
      calls.push({ query, options });
      return overrides.searchLexical ? overrides.searchLexical(query, options) : [];
    },
  };
}

describe('CanonicalRagShadowService', () => {
  beforeEach(() => CanonicalRagShadowService.resetDiagnostics());

  test('executes lexical shadow for the selected canonical source families', async () => {
    const storage = makeStorage({ searchLexical: () => [{}, {}] });
    const service = new CanonicalRagShadowService(storage);
    const diagnostic = await service.observe('quarterly plan', {
      sourceTypes: ['meeting', 'mode-reference', 'personal-files', 'knowledge'],
      legacyResultCount: 7,
    });

    assert.equal(diagnostic.succeeded, true);
    assert.deepEqual(diagnostic.sourceTypes, ['meeting', 'mode', 'personal']);
    assert.equal(diagnostic.legacyResultCount, 7);
    assert.equal(diagnostic.canonicalResultCount, 6);
    assert.equal(storage.calls.length, 3);
    assert.deepEqual(storage.calls.map((call) => call.options.sourceType), ['meeting', 'mode', 'personal']);
    assert.ok(diagnostic.durationMs >= 0);
  });

  test('does not call an embedding provider', async () => {
    const storage = makeStorage();
    const service = new CanonicalRagShadowService(storage);
    const diagnostic = await service.observe('embedding-free shadow');

    assert.equal(diagnostic.succeeded, true);
    assert.equal(storage.calls.length, 3);
  });

  test('performs no canonical writes', async () => {
    const storage = makeStorage();
    const service = new CanonicalRagShadowService(storage);
    await service.observe('read only');

    assert.deepEqual(Object.keys(storage).sort(), ['calls', 'searchLexical']);
  });

  test('does not mutate legacy result arrays', async () => {
    const storage = makeStorage();
    const service = new CanonicalRagShadowService(storage);
    const legacyResults = [{ id: 'a' }, { id: 'b' }];
    const before = structuredClone(legacyResults);

    await service.observe('same legacy results', { legacyResultCount: legacyResults.length });

    assert.deepEqual(legacyResults, before);
  });

  test('filters unsupported source families without failing the shadow', async () => {
    const storage = makeStorage();
    const service = new CanonicalRagShadowService(storage);
    const diagnostic = await service.observe('knowledge only', { sourceTypes: ['knowledge'] });

    assert.equal(diagnostic.succeeded, true);
    assert.deepEqual(diagnostic.sourceTypes, []);
    assert.equal(storage.calls.length, 0);
  });

  test('shadow storage failure is isolated and reported without throwing', async () => {
    const storage = makeStorage({ searchLexical: () => { throw new Error('fts unavailable'); } });
    const service = new CanonicalRagShadowService(storage);
    const diagnostic = await service.observe('failure path', { legacyResultCount: 4 });

    assert.equal(diagnostic.succeeded, false);
    assert.equal(diagnostic.legacyResultCount, 4);
    assert.equal(diagnostic.errorCategory, 'query');
    assert.ok(diagnostic.durationMs >= 0);
  });

  test('diagnostics contain only content-free counts/status/latency metadata', async () => {
    const storage = makeStorage({ searchLexical: () => [{ chunk: { text: 'secret' } }] });
    const service = new CanonicalRagShadowService(storage);
    await service.observe('private user query', { legacyResultCount: 2 });

    const [diagnostic] = CanonicalRagShadowService.recentDiagnostics(1);
    assert.equal(diagnostic.enabled, true);
    assert.equal(diagnostic.succeeded, true);
    assert.equal(diagnostic.legacyResultCount, 2);
    assert.equal(diagnostic.canonicalResultCount, 3);
    assert.ok('durationMs' in diagnostic);
    assert.equal(JSON.stringify(diagnostic).includes('private user query'), false);
    assert.equal(JSON.stringify(diagnostic).includes('secret'), false);
  });

  test('requested per-source limit is passed to canonical lexical reads', async () => {
    const storage = makeStorage();
    const service = new CanonicalRagShadowService(storage);
    await service.observe('bounded', { sourceTypes: ['meeting'], limit: 12 });

    assert.equal(storage.calls.length, 1);
    assert.equal(storage.calls[0].options.limit, 12);
  });
});
