import assert from 'node:assert/strict';
import test from 'node:test';

const modulePath = new URL('../../../dist-electron/electron/rag/canonical/CanonicalRagReadService.js', import.meta.url).href;
const { CanonicalRagReadService } = await import(modulePath);

function canonicalResult(overrides = {}) {
  return {
    chunk: {
      id: 'chunk-1',
      documentId: 'doc-1',
      revisionId: 'rev-1',
      chunkIndex: 0,
      text: 'canonical text',
      contentHash: 'hash-1',
      pageStart: null,
      pageEnd: null,
      section: null,
      heading: null,
      contentType: 'text',
      startChar: null,
      endChar: null,
      tableIndex: null,
      tokenCount: 2,
      speaker: null,
      timestampStart: null,
      timestampEnd: null,
      sourceLocator: null,
      metadata: {},
      createdAt: '2026-09-15T00:00:00.000Z',
    },
    document: {
      id: 'doc-1',
      sourceType: 'personal',
      sourceId: 'file-1',
      ownerId: null,
      scopeId: null,
      name: 'notes.txt',
      path: null,
      mimeType: 'text/plain',
      fileType: 'txt',
      sizeBytes: 10,
      contentHash: 'doc-hash',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
      currentRevisionId: 'rev-1',
      deletedAt: null,
      metadata: {},
    },
    score: -1,
    ...overrides,
  };
}

function legacyResult() {
  return [{
    chunk: {
      id: 'legacy-1',
      documentId: 'file-1',
      text: 'legacy text',
      chunkIndex: 0,
      metadata: {},
    },
    score: 0.8,
    source: {
      id: 'file-1',
      sourceType: 'personal',
      name: 'notes.txt',
      metadata: {},
    },
  }];
}

test('uses canonical results when canonical retrieval succeeds', async () => {
  let fallbackCalls = 0;
  const service = new CanonicalRagReadService({
    async searchLexical() { return [canonicalResult()]; },
  });

  const result = await service.readSource({
    query: 'hello',
    sourceType: 'personal',
    limit: 8,
    fallback: async () => { fallbackCalls++; return legacyResult(); },
  });

  assert.equal(result.usedCanonical, true);
  assert.equal(result.fallbackReason, null);
  assert.equal(result.results[0].chunk.text, 'canonical text');
  assert.equal(result.results[0].source.id, 'file-1');
  assert.equal(fallbackCalls, 0);
});

test('falls back to legacy retrieval when canonical coverage is empty', async () => {
  const service = new CanonicalRagReadService({
    async searchLexical() { return []; },
  });

  const result = await service.readSource({
    query: 'hello',
    sourceType: 'meeting',
    sourceId: 'meeting-1',
    limit: 8,
    fallback: async () => legacyResult(),
  });

  assert.equal(result.usedCanonical, false);
  assert.equal(result.fallbackReason, 'empty');
  assert.equal(result.results[0].chunk.text, 'legacy text');
});

test('falls back to legacy retrieval when canonical storage fails', async () => {
  const service = new CanonicalRagReadService({
    async searchLexical() { throw new Error('sqlite unavailable'); },
  });

  const result = await service.readSource({
    query: 'hello',
    sourceType: 'mode',
    scopeId: 'mode-1',
    limit: 8,
    fallback: async () => legacyResult(),
  });

  assert.equal(result.usedCanonical, false);
  assert.equal(result.fallbackReason, 'error');
  assert.equal(result.results[0].chunk.text, 'legacy text');
});

test('passes source identity and scope filters to canonical storage', async () => {
  let request;
  const service = new CanonicalRagReadService({
    async searchLexical(query, options) {
      request = { query, options };
      return [canonicalResult({ document: { ...canonicalResult().document, sourceType: 'mode', sourceId: 'file-2', scopeId: 'mode-2' } })];
    },
  });

  await service.readSource({
    query: '  scoped query  ',
    sourceType: 'mode',
    sourceId: 'file-2',
    scopeId: 'mode-2',
    limit: 500,
    fallback: async () => [],
  });

  assert.equal(request.query, 'scoped query');
  assert.deepEqual(request.options, {
    sourceType: 'mode',
    sourceId: 'file-2',
    scopeId: 'mode-2',
    limit: 200,
  });
});

test('does not invoke canonical storage for an empty query', async () => {
  let storageCalls = 0;
  let fallbackCalls = 0;
  const service = new CanonicalRagReadService({
    async searchLexical() { storageCalls++; return []; },
  });

  const result = await service.readSource({
    query: '   ',
    sourceType: 'personal',
    limit: 8,
    fallback: async () => { fallbackCalls++; return legacyResult(); },
  });

  assert.equal(storageCalls, 0);
  assert.equal(fallbackCalls, 0);
  assert.deepEqual(result.results, []);
  assert.equal(result.usedCanonical, true);
  assert.equal(result.fallbackReason, null);
});

test('vector hits in the query embedding space count as canonical coverage without a lexical match', async () => {
  let vectorCalls = 0;
  const service = new CanonicalRagReadService({
    async searchLexical() { return []; },
    searchVector(queryEmbedding, options) {
      vectorCalls += 1;
      assert.deepEqual(queryEmbedding, [1, 0]);
      assert.equal(options.embeddingSpaceId, 'space-a');
      assert.equal(options.sourceType, 'mode');
      return [{
        ...canonicalResult(),
        embeddingSpaceId: 'space-a',
        physicalRowKey: 1,
        distance: 0.1,
      }];
    },
  });

  const result = await service.readSource({
    query: 'hello',
    sourceType: 'mode',
    limit: 8,
    queryEmbedding: [1, 0],
    embeddingSpaceId: 'space-a',
    fallback: async () => legacyResult(),
  });

  assert.equal(vectorCalls, 1);
  assert.equal(result.usedCanonical, true);
  assert.equal(result.fallbackReason, null);
  assert.equal(result.results[0].chunk.text, 'canonical text');
  assert.equal(result.results[0].semanticScore, -0.1);
});

test('does not search vectors without an embedding space, and never mixes a second space into the query', async () => {
  let vectorCalls = 0;
  const service = new CanonicalRagReadService({
    async searchLexical() { return [canonicalResult()]; },
    searchVector() { vectorCalls += 1; return []; },
  });

  const lexicalOnly = await service.readSource({
    query: 'hello',
    sourceType: 'personal',
    limit: 8,
    fallback: async () => legacyResult(),
  });

  assert.equal(vectorCalls, 0);
  assert.equal(lexicalOnly.usedCanonical, true);

  await service.readSource({
    query: 'hello',
    sourceType: 'personal',
    limit: 8,
    queryEmbedding: [1, 0],
    embeddingSpaceId: 'space-a',
    fallback: async () => legacyResult(),
  });

  assert.equal(vectorCalls, 1);
});

test('keeps lexical hits when vector search throws', async () => {
  const service = new CanonicalRagReadService({
    async searchLexical() { return [canonicalResult()]; },
    searchVector() { throw new Error('vec0 unavailable'); },
  });

  const result = await service.readSource({
    query: 'hello',
    sourceType: 'personal',
    limit: 8,
    queryEmbedding: [1, 0],
    embeddingSpaceId: 'space-a',
    fallback: async () => legacyResult(),
  });

  assert.equal(result.usedCanonical, true);
  assert.equal(result.results[0].chunk.text, 'canonical text');
});
