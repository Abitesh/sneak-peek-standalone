import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CanonicalRagComparisonService } from '../../../dist-electron/electron/rag/canonical/CanonicalRagComparisonService.js';

function candidate(overrides = {}) {
  return {
    sourceType: 'personal',
    sourceId: 'file-1',
    chunkId: 'chunk-1',
    chunkIndex: 0,
    contentHash: 'hash-1',
    rank: 1,
    score: 0.8,
    ...overrides,
  };
}

function compare(legacy, canonical, overrides = {}) {
  return new CanonicalRagComparisonService().compare({
    path: 'test',
    sourceType: 'personal',
    legacy,
    canonical,
    ...overrides,
  }).comparison;
}

describe('CanonicalRagComparisonService', () => {
  test('detects exact logical parity when migrated legacy identity is preserved', () => {
    const result = compare(
      [candidate({ legacyChunkId: 'legacy-1', chunkId: 'legacy-public-id' })],
      [candidate({ legacyChunkId: 'legacy-1', chunkId: 'canonical-opaque-id', documentId: 'canonical-doc', revisionId: 'rev-1' })],
    );

    assert.deepEqual(result.classifications, ['EXACT_RESULT_PARITY']);
    assert.equal(result.logicalOverlapCount, 1);
  });

  test('does not treat different physical IDs as different when logical metadata matches', () => {
    const result = compare(
      [candidate({ chunkId: 'legacy-1' })],
      [candidate({ chunkId: 'canonical-1' })],
    );

    assert.deepEqual(result.classifications, ['EXACT_RESULT_PARITY']);
    assert.equal(result.logicalOverlapCount, 1);
  });

  test('detects candidate misses', () => {
    const result = compare(
      [candidate()],
      [candidate({ chunkIndex: 1, contentHash: 'hash-2', chunkId: 'chunk-2' })],
    );

    assert.ok(result.classifications.includes('CANDIDATE_MISS'));
    assert.equal(result.legacyOnlyCount, 1);
    assert.equal(result.canonicalOnlyCount, 1);
  });

  test('detects ranking divergence without comparing raw score scales', () => {
    const result = compare(
      [candidate(), candidate({ chunkIndex: 1, contentHash: 'hash-2', chunkId: 'chunk-2', rank: 2, score: 0.2 })],
      [candidate({ rank: 2, score: 91 }), candidate({ chunkIndex: 1, contentHash: 'hash-2', chunkId: 'chunk-2', rank: 1, score: 3 })],
    );

    assert.ok(result.classifications.includes('RANKING_DIVERGENCE'));
    assert.equal(result.rankDifferences, 2);
  });

  test('detects duplicate logical results', () => {
    const result = compare([candidate(), candidate()], [candidate()]);

    assert.ok(result.classifications.includes('DUPLICATE_LOGICAL_RESULT'));
    assert.equal(result.duplicateLogicalLegacyCount, 1);
  });

  test('knowledge remains not comparable', () => {
    const result = compare(
      [candidate({ sourceType: 'knowledge' })],
      [],
      { sourceType: 'knowledge' },
    );

    assert.deepEqual(result.classifications, ['NOT_COMPARABLE']);
  });

  test('records filter contract without changing candidates', () => {
    const legacy = [candidate()];
    const canonical = [candidate()];
    const result = compare(legacy, canonical, {
      filter: {
        sourceIdsPresent: true,
        scopeIdPresent: false,
        currentRevisionRequired: true,
        readyRequired: true,
      },
    });

    assert.deepEqual(result.filter, {
      sourceIdsPresent: true,
      scopeIdPresent: false,
      currentRevisionRequired: true,
      readyRequired: true,
    });
    assert.equal(legacy[0].chunkId, 'chunk-1');
    assert.equal(canonical[0].chunkId, 'chunk-1');
  });

  test('comparison diagnostics contain no chunk text or prompt content', () => {
    const result = compare(
      [candidate()],
      [candidate({ score: 0.9 })],
    );

    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('text'), false);
    assert.equal(serialized.includes('prompt'), false);
  });
});
