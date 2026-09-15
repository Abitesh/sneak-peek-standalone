import assert from 'node:assert/strict';
import test from 'node:test';

const modulePath = new URL('../../../dist-electron/electron/rag/canonical/CanonicalRagReadAdapter.js', import.meta.url).href;
const { toLegacyRagSearchResult } = await import(modulePath);

test('maps canonical lexical result into the live RagSearchResult contract', () => {
  const result = toLegacyRagSearchResult({
    chunk: {
      id: 'chunk-1',
      documentId: 'doc-1',
      revisionId: 'rev-1',
      chunkIndex: 3,
      text: 'hello world',
      contentHash: 'hash-1',
      pageStart: 2,
      pageEnd: 4,
      section: 'intro',
      heading: 'Hello',
      contentType: 'text',
      startChar: 10,
      endChar: 21,
      tableIndex: null,
      tokenCount: 5,
      speaker: null,
      timestampStart: 100,
      timestampEnd: 200,
      sourceLocator: 'page:2',
      metadata: { legacyChunkId: 'legacy-1' },
      createdAt: '2026-09-14T00:00:00.000Z',
    },
    document: {
      id: 'doc-1',
      sourceType: 'personal',
      sourceId: 'file-1',
      ownerId: null,
      scopeId: null,
      name: 'notes.txt',
      path: '/tmp/notes.txt',
      mimeType: 'text/plain',
      fileType: 'txt',
      sizeBytes: 100,
      contentHash: 'doc-hash',
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z',
      currentRevisionId: 'rev-1',
      deletedAt: null,
      metadata: { source: 'test' },
    },
    score: -1.25,
  });

  assert.equal(result.chunk.id, 'chunk-1');
  assert.equal(result.chunk.documentId, 'file-1');
  assert.equal(result.chunk.chunkIndex, 3);
  assert.equal(result.chunk.pageStart, 2);
  assert.equal(result.chunk.pageEnd, 4);
  assert.equal(result.chunk.section, 'intro');
  assert.equal(result.chunk.heading, 'Hello');
  assert.equal(result.chunk.startOffset, 10);
  assert.equal(result.chunk.timestampStart, 100);
  assert.equal(result.chunk.timestampEnd, 200);
  assert.equal(result.chunk.metadata.legacyChunkId, 'legacy-1');
  assert.equal(result.chunk.metadata.canonicalDocumentId, 'doc-1');
  assert.equal(result.chunk.metadata.canonicalRevisionId, 'rev-1');
  assert.equal(result.chunk.metadata.canonicalContentHash, 'hash-1');
  assert.equal(result.source.id, 'file-1');
  assert.equal(result.source.sourceType, 'personal');
  assert.equal(result.source.name, 'notes.txt');
  assert.equal(result.source.path, '/tmp/notes.txt');
  assert.equal(result.source.metadata.canonicalDocumentId, 'doc-1');
  assert.equal(result.source.metadata.canonicalSourceId, 'file-1');
  assert.equal(result.score, -1.25);
  assert.equal(result.lexicalScore, -1.25);
  assert.equal(result.semanticScore, undefined);
  assert.equal(result.rerankScore, undefined);
});

test('omits canonical nullable fields instead of emitting null into the legacy optional contract', () => {
  const result = toLegacyRagSearchResult({
    chunk: {
      id: 'chunk-2',
      documentId: 'doc-2',
      revisionId: 'rev-2',
      chunkIndex: 0,
      text: 'text',
      contentHash: 'hash-2',
      pageStart: null,
      pageEnd: null,
      section: null,
      heading: null,
      contentType: null,
      startChar: null,
      endChar: null,
      tableIndex: null,
      tokenCount: null,
      speaker: null,
      timestampStart: null,
      timestampEnd: null,
      sourceLocator: null,
      metadata: {},
      createdAt: '2026-09-14T00:00:00.000Z',
    },
    document: {
      id: 'doc-2',
      sourceType: 'meeting',
      sourceId: 'meeting-1',
      ownerId: null,
      scopeId: null,
      name: 'meeting',
      path: null,
      mimeType: null,
      fileType: null,
      sizeBytes: null,
      contentHash: null,
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z',
      currentRevisionId: 'rev-2',
      deletedAt: null,
      metadata: {},
    },
    score: 0,
  });

  assert.equal(result.chunk.pageStart, undefined);
  assert.equal(result.chunk.section, undefined);
  assert.equal(result.chunk.startOffset, undefined);
  assert.equal(result.source.path, undefined);
  assert.equal(result.source.mimeType, undefined);
  assert.equal(result.source.metadata.canonicalSourceId, 'meeting-1');
  assert.equal(result.source.id, 'meeting-1');
  assert.equal(result.chunk.documentId, 'meeting-1');
});

test('rejects an unknown canonical source type instead of fabricating a legacy source type', () => {
  assert.throws(
    () => toLegacyRagSearchResult({
      chunk: {
        id: 'chunk-3', documentId: 'doc-3', revisionId: 'rev-3', chunkIndex: 0,
        text: 'text', contentHash: 'hash', pageStart: null, pageEnd: null,
        section: null, heading: null, contentType: null, startChar: null, endChar: null,
        tableIndex: null, tokenCount: null, speaker: null, timestampStart: null,
        timestampEnd: null, sourceLocator: null, metadata: {}, createdAt: 'now',
      },
      document: {
        id: 'doc-3', sourceType: 'future-source', sourceId: 'x', ownerId: null,
        scopeId: null, name: 'x', path: null, mimeType: null, fileType: null,
        sizeBytes: null, contentHash: null, createdAt: 'now', updatedAt: 'now',
        currentRevisionId: 'rev-3', deletedAt: null, metadata: {},
      },
      score: 1,
    }),
    /Unsupported canonical RAG source type/,
  );
});


test('does not mutate the canonical input and maps deterministically', () => {
  const input = {
    chunk: {
      id: 'chunk-stable',
      documentId: 'canonical-doc',
      revisionId: 'rev-stable',
      chunkIndex: 2,
      text: 'stable text',
      contentHash: 'hash-stable',
      pageStart: 1,
      pageEnd: 1,
      section: 'section',
      heading: 'heading',
      contentType: 'text',
      startChar: 0,
      endChar: 12,
      tableIndex: null,
      tokenCount: 2,
      speaker: 'Speaker',
      timestampStart: 10,
      timestampEnd: 20,
      sourceLocator: 'page:1',
      metadata: { legacyChunkId: 'legacy-stable' },
      createdAt: '2026-09-14T00:00:00.000Z',
    },
    document: {
      id: 'canonical-doc',
      sourceType: 'mode',
      sourceId: 'mode-file-1',
      ownerId: 'owner-1',
      scopeId: 'mode-1',
      name: 'stable',
      path: null,
      mimeType: 'text/plain',
      fileType: 'txt',
      sizeBytes: 12,
      contentHash: 'doc-hash',
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z',
      currentRevisionId: 'rev-stable',
      deletedAt: null,
      metadata: { source: 'test' },
    },
    score: -0.5,
  };

  const before = structuredClone(input);
  const first = toLegacyRagSearchResult(input);
  const second = toLegacyRagSearchResult(input);

  assert.deepEqual(input, before);
  assert.deepEqual(first, second);
  assert.equal(first.chunk.speaker, 'Speaker');
  assert.equal(first.chunk.timestampEnd, 20);
  assert.equal(first.source.id, 'mode-file-1');
  assert.equal(first.chunk.documentId, 'mode-file-1');
});

test('rejects non-finite scores instead of emitting an invalid legacy score', () => {
  const base = {
    chunk: {
      id: 'chunk-score',
      documentId: 'doc-score',
      revisionId: 'rev-score',
      chunkIndex: 0,
      text: 'text',
      contentHash: 'hash',
      pageStart: null,
      pageEnd: null,
      section: null,
      heading: null,
      contentType: null,
      startChar: null,
      endChar: null,
      tableIndex: null,
      tokenCount: null,
      speaker: null,
      timestampStart: null,
      timestampEnd: null,
      sourceLocator: null,
      metadata: {},
      createdAt: 'now',
    },
    document: {
      id: 'doc-score',
      sourceType: 'personal',
      sourceId: 'file-score',
      ownerId: null,
      scopeId: null,
      name: 'score',
      path: null,
      mimeType: null,
      fileType: null,
      sizeBytes: null,
      contentHash: null,
      createdAt: 'now',
      updatedAt: 'now',
      currentRevisionId: 'rev-score',
      deletedAt: null,
      metadata: {},
    },
  };

  for (const score of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(
      () => toLegacyRagSearchResult({ ...base, score }),
      /score must be finite/,
    );
  }
});
