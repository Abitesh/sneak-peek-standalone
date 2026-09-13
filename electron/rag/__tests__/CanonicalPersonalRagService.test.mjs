import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { installCanonicalRagSchema } from '../../../dist-electron/electron/rag/canonical/CanonicalRagSchema.js';
import { CanonicalRagStorage } from '../../../dist-electron/electron/rag/canonical/CanonicalRagStorage.js';
import { CanonicalEmbeddingService } from '../../../dist-electron/electron/rag/canonical/CanonicalEmbeddingService.js';
import { CanonicalPersonalRagService } from '../../../dist-electron/electron/rag/canonical/CanonicalPersonalRagService.js';

function setup() {
  const db = new Database(':memory:');
  db.loadExtension(sqliteVec.getLoadablePath());
  installCanonicalRagSchema(db);
  const storage = new CanonicalRagStorage(db);
  const legacy = {
    readDocument(id) {
      return {
        id,
        sourceType: 'personal',
        name: 'resume.pdf',
        path: '/personal/resume.pdf',
        mimeType: 'application/pdf',
        metadata: { fileType: 'resume', sizeBytes: 123, contentHash: 'abc123' },
      };
    },
    readChunks() {
      return [
        { id: 'pchunk_a', documentId: 'legacy-file-1', chunkIndex: 0, text: 'Distributed systems and databases', startOffset: 0, endOffset: 34, metadata: {} },
        { id: 'pchunk_b', documentId: 'legacy-file-1', chunkIndex: 1, text: 'C++ and TypeScript engineering', startOffset: 35, endOffset: 65, metadata: {} },
      ];
    },
  };
  const provider = {
    provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dimensions: 3, version: 'pipeline-v1',
    async embedBatch(texts) { return texts.map((_, i) => [i + 1, 0, 0]); },
  };
  const embedding = new CanonicalEmbeddingService(storage, provider);
  const service = new CanonicalPersonalRagService(storage, legacy, embedding);
  return { db, storage, service };
}

test('projects a legacy personal file into canonical storage and activates the ready revision', async () => {
  const { db, storage, service } = setup();
  const result = await service.projectPersonalFile('legacy-file-1');
  assert.equal(result.complete, true);
  assert.equal(result.activated, true);
  assert.equal(result.chunkCount, 2);
  assert.equal(result.embeddedChunkCount, 2);

  const doc = storage.readDocument(result.documentId);
  assert.ok(doc);
  assert.equal(doc.sourceType, 'personal');
  assert.equal(doc.sourceId, 'legacy-file-1');
  assert.equal(doc.currentRevisionId, result.revisionId);
  assert.notEqual(doc.id, 'legacy-file-1');

  assert.equal(storage.readChunks(result.revisionId).length, 2);
  assert.equal(storage.getStatus(result.documentId, result.revisionId)?.status, 'READY');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_embeddings').get().n, 2);
  db.close();
});

test('projection is idempotent for the same personal file representation', async () => {
  const { db, storage, service } = setup();
  const first = await service.projectPersonalFile('legacy-file-1');
  const second = await service.projectPersonalFile('legacy-file-1');
  assert.equal(second.documentId, first.documentId);
  assert.equal(second.revisionId, first.revisionId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_documents').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_document_revisions').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_chunks').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_embeddings').get().n, 2);
  assert.equal(storage.readDocument(first.documentId)?.currentRevisionId, first.revisionId);
  db.close();
});

test('embedding model changes create a new canonical space without changing document, revision, or chunk identity', async () => {
  const { db, storage, service } = setup();
  const first = await service.projectPersonalFile('legacy-file-1');
  const doc = storage.readDocument(first.documentId);
  const firstChunks = storage.readChunks(first.revisionId).map((chunk) => chunk.id);

  const secondProvider = {
    provider: 'local', model: 'another-local-model', dimensions: 3, version: 'pipeline-v1',
    async embedBatch(texts) { return texts.map((_, i) => [0, i + 1, 0]); },
  };
  const secondEmbedding = new CanonicalEmbeddingService(storage, secondProvider);
  const secondService = new CanonicalPersonalRagService(storage, {
    readDocument: (id) => ({ id, sourceType: 'personal', name: 'resume.pdf', path: '/personal/resume.pdf', mimeType: 'application/pdf', metadata: { fileType: 'resume', sizeBytes: 123, contentHash: 'abc123' } }),
    readChunks: () => [
      { id: 'pchunk_a', documentId: 'legacy-file-1', chunkIndex: 0, text: 'Distributed systems and databases', startOffset: 0, endOffset: 34, metadata: {} },
      { id: 'pchunk_b', documentId: 'legacy-file-1', chunkIndex: 1, text: 'C++ and TypeScript engineering', startOffset: 35, endOffset: 65, metadata: {} },
    ],
  }, secondEmbedding);
  const second = await secondService.projectPersonalFile('legacy-file-1');

  assert.equal(second.documentId, first.documentId);
  assert.equal(second.revisionId, first.revisionId);
  assert.notEqual(second.embeddingSpaceId, first.embeddingSpaceId);
  assert.deepEqual(storage.readChunks(first.revisionId).map((chunk) => chunk.id), firstChunks);
  assert.equal(doc.currentRevisionId, first.revisionId);
  assert.equal(storage.listEmbeddingSpaces().length, 2);
  db.close();
});

test('canonical personal projection does not write legacy storage', async () => {
  const { db, service } = setup();
  db.exec('CREATE TABLE personal_files (id TEXT PRIMARY KEY, file_name TEXT NOT NULL)');
  db.prepare('INSERT INTO personal_files (id, file_name) VALUES (?, ?)').run('legacy-file-1', 'resume.pdf');
  const legacyBefore = db.prepare('SELECT * FROM personal_files WHERE id = ?').get('legacy-file-1');
  await service.projectPersonalFile('legacy-file-1');
  const legacyAfter = db.prepare('SELECT * FROM personal_files WHERE id = ?').get('legacy-file-1');
  assert.deepEqual(legacyAfter, legacyBefore);
  const canonicalCount = db.prepare('SELECT COUNT(*) AS n FROM rag_documents').get().n;
  assert.equal(canonicalCount, 1);
  db.close();
});
