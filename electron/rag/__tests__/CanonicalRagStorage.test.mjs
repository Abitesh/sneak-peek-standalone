import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { installCanonicalRagSchema } from '../../../dist-electron/electron/rag/canonical/CanonicalRagSchema.js';
import { CanonicalRagStorage } from '../../../dist-electron/electron/rag/canonical/CanonicalRagStorage.js';

function makeDb({ vector = false } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  if (vector) {
    let ext = sqliteVec.getLoadablePath();
    ext = ext.replace('app.asar', 'app.asar.unpacked').replace(/\.(dylib|so|dll)$/, '');
    db.loadExtension(ext);
  }
  installCanonicalRagSchema(db);
  return db;
}

function makeVectorStorage() {
  return (() => {
    try {
      const db = makeDb({ vector: true });
      return { db, storage: new CanonicalRagStorage(db) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.fail(`sqlite-vec is required for vector tests but could not be loaded: ${message}`);
    }
  })();
}

function makeStorage() {
  const db = makeDb();
  return { db, storage: new CanonicalRagStorage(db) };
}

function seedRevision(storage, suffix = '1') {
  const doc = storage.createDocument({ sourceType: 'personal', sourceId: `source-${suffix}`, name: `Doc ${suffix}` });
  const revision = storage.createRevision({
    documentId: doc.id,
    contentHash: `content-${suffix}`,
    extractionVersion: 'extract-v1',
    chunkingVersion: 'chunk-v1',
    normalizationVersion: 'norm-v1',
  });
  storage.replaceChunks(doc.id, revision.id, [{
    chunkIndex: 0,
    text: `hello canonical ${suffix}`,
    sourceLocator: 'p1:0-20',
    pageStart: 1,
    pageEnd: 1,
    heading: 'Heading',
  }]);
  return { doc, revision, chunk: storage.readChunks(revision.id)[0] };
}

test('document source identity is unique and creation is idempotent', () => {
  const { db, storage } = makeStorage();
  const first = storage.createDocument({ sourceType: 'mode', sourceId: 'same', name: 'A' });
  const second = storage.createDocument({ sourceType: 'mode', sourceId: 'same', name: 'B' });
  assert.equal(second.id, first.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_documents').get().n, 1);
  db.close();
});

test('revision identity is deterministic and changes with content/chunking but not embedding model', () => {
  const { db, storage } = makeStorage();
  const doc = storage.createDocument({ sourceType: 'personal', sourceId: 'r', name: 'R' });
  const a = storage.createRevision({ documentId: doc.id, contentHash: 'h1', extractionVersion: 'e1', chunkingVersion: 'c1', normalizationVersion: 'n1' });
  const same = storage.createRevision({ documentId: doc.id, contentHash: 'h1', extractionVersion: 'e1', chunkingVersion: 'c1', normalizationVersion: 'n1' });
  const content = storage.createRevision({ documentId: doc.id, contentHash: 'h2', extractionVersion: 'e1', chunkingVersion: 'c1', normalizationVersion: 'n1' });
  const chunking = storage.createRevision({ documentId: doc.id, contentHash: 'h1', extractionVersion: 'e1', chunkingVersion: 'c2', normalizationVersion: 'n1' });
  assert.equal(a.id, same.id);
  assert.notEqual(a.id, content.id);
  assert.notEqual(a.id, chunking.id);
  const space = storage.createEmbeddingSpace({ provider: 'p', model: 'm1', dimensions: 2, version: '1' });
  const space2 = storage.createEmbeddingSpace({ provider: 'p', model: 'm2', dimensions: 2, version: '1' });
  assert.notEqual(space.id, space2.id);
  assert.equal(storage.readRevision(a.id).revisionNumber, 1);
  db.close();
});

test('chunk identity uses revision, locator and text content', () => {
  const { db, storage } = makeStorage();
  const doc = storage.createDocument({ sourceType: 'personal', sourceId: 'c', name: 'C' });
  const rev = storage.createRevision({ documentId: doc.id, contentHash: 'h', extractionVersion: 'e', chunkingVersion: 'c', normalizationVersion: 'n' });
  storage.replaceChunks(doc.id, rev.id, [{ chunkIndex: 0, text: 'same', sourceLocator: 'loc-a' }]);
  const first = storage.readChunks(rev.id)[0];
  storage.replaceChunks(doc.id, rev.id, [{ chunkIndex: 0, text: 'same', sourceLocator: 'loc-b' }]);
  const second = storage.readChunks(rev.id)[0];
  assert.notEqual(first.id, second.id);
  db.close();
});

test('cross-document chunk/revision mismatch is rejected by composite foreign key', () => {
  const { db, storage } = makeStorage();
  const a = storage.createDocument({ sourceType: 'personal', sourceId: 'a', name: 'A' });
  const b = storage.createDocument({ sourceType: 'personal', sourceId: 'b', name: 'B' });
  const rev = storage.createRevision({ documentId: a.id, contentHash: 'ha', extractionVersion: 'e', chunkingVersion: 'c', normalizationVersion: 'n' });
  assert.throws(() => db.prepare(`INSERT INTO rag_chunks (id, document_id, revision_id, chunk_index, text, content_hash, metadata_json, created_at) VALUES (?, ?, ?, 0, ?, ?, '{}', ?)`).run('bad', b.id, rev.id, 'bad', 'bad', new Date().toISOString()));
  db.close();
});

test('current revision cannot point to another document', () => {
  const { db, storage } = makeStorage();
  const a = storage.createDocument({ sourceType: 'personal', sourceId: 'ca', name: 'A' });
  const b = storage.createDocument({ sourceType: 'personal', sourceId: 'cb', name: 'B' });
  const rb = storage.createRevision({ documentId: b.id, contentHash: 'hb', extractionVersion: 'e', chunkingVersion: 'c', normalizationVersion: 'n' });
  assert.throws(() => db.prepare('UPDATE rag_documents SET current_revision_id = ? WHERE id = ?').run(rb.id, a.id));
  db.close();
});

test('embedding spaces are dimension-specific by full compatibility tuple', () => {
  const { db, storage } = makeStorage();
  const a = storage.createEmbeddingSpace({ provider: 'x', model: 'm', dimensions: 2, version: '1' });
  const same = storage.createEmbeddingSpace({ provider: 'x', model: 'm', dimensions: 2, version: '1' });
  const b = storage.createEmbeddingSpace({ provider: 'x', model: 'm', dimensions: 3, version: '1' });
  assert.equal(a.id, same.id);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.vectorTableKey, b.vectorTableKey);
  db.close();
});

test('invalid vectors are rejected before persistence', () => {
  const { db, storage } = makeVectorStorage();
  const { chunk } = seedRevision(storage, 'vec');
  const space = storage.createEmbeddingSpace({ provider: 'x', model: 'm', dimensions: 2, version: '1' });
  assert.throws(() => storage.storeEmbedding(chunk.id, space.id, [1]));
  assert.throws(() => storage.storeEmbedding(chunk.id, space.id, [1, Number.NaN]));
  assert.throws(() => storage.storeEmbedding(chunk.id, space.id, [1, Number.POSITIVE_INFINITY]));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_embeddings').get().n, 0);
  db.close();
});

test('multiple embedding spaces can coexist on one chunk', () => {
  const { db, storage } = makeVectorStorage();
  const { chunk } = seedRevision(storage, 'multi');
  const a = storage.createEmbeddingSpace({ provider: 'x', model: 'a', dimensions: 2, version: '1' });
  const b = storage.createEmbeddingSpace({ provider: 'x', model: 'b', dimensions: 2, version: '1' });
  storage.storeEmbedding(chunk.id, a.id, [1, 0]);
  storage.storeEmbedding(chunk.id, b.id, [0, 1]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_embeddings WHERE chunk_id = ?').get(chunk.id).n, 2);
  db.close();
});

test('FTS rebuild reproduces canonical chunks', () => {
  const { db, storage } = makeStorage();
  const { revision } = seedRevision(storage, 'fts');
  assert.deepEqual(storage.checkFts(revision.id), { expected: 1, actual: 1, missing: 0 });
  db.prepare('DELETE FROM rag_chunks_fts').run();
  assert.equal(storage.checkFts(revision.id).actual, 0);
  storage.rebuildFts(revision.id);
  assert.deepEqual(storage.checkFts(revision.id), { expected: 1, actual: 1, missing: 0 });
  const hit = db.prepare(`SELECT chunk_id FROM rag_chunks_fts WHERE rag_chunks_fts MATCH ?`).get('canonical');
  assert.equal(hit.chunk_id, storage.readChunks(revision.id)[0].id);
  db.close();
});

test('canonical embedding produces a vector row keyed by physical_row_key and rebuild is consistent', () => {
  const { db, storage } = makeVectorStorage();
  const { chunk } = seedRevision(storage, 'vector-map');
  const space = storage.createEmbeddingSpace({ provider: 'x', model: 'm', dimensions: 2, version: '1' });
  const embedding = storage.storeEmbedding(chunk.id, space.id, [1, 0]);
  const vectorRow = db.prepare(`SELECT rowid AS physical_row_key FROM vec_rag_embeddings_${space.vectorTableKey}`).get();
  assert.equal(Number(vectorRow.physical_row_key), embedding.physicalRowKey);
  assert.deepEqual(storage.checkVectorIndex(space.id).missingVectorRows, 0);
  db.prepare(`DELETE FROM vec_rag_embeddings_${space.vectorTableKey}`).run();
  assert.equal(storage.checkVectorIndex(space.id).missingVectorRows, 1);
  storage.rebuildVectorIndex(space.id);
  assert.equal(storage.checkVectorIndex(space.id).missingVectorRows, 0);
  db.close();
});

test('status transition validation rejects invalid transitions', () => {
  const { db, storage } = makeStorage();
  const { doc, revision } = seedRevision(storage, 'status');
  assert.equal(storage.getStatus(doc.id, revision.id).status, 'LEXICAL_READY');
  assert.throws(() => storage.setStatus(doc.id, revision.id, 'EXTRACTING'));
  storage.setStatus(doc.id, revision.id, 'EMBEDDING');
  storage.setStatus(doc.id, revision.id, 'READY', { chunkCount: 1 });
  assert.equal(storage.getStatus(doc.id, revision.id).status, 'READY');
  db.close();
});

test('embedding jobs are idempotent per revision and embedding space', () => {
  const { db, storage } = makeStorage();
  const { doc, revision } = seedRevision(storage, 'jobs');
  const a = storage.createEmbeddingSpace({ provider: 'x', model: 'a', dimensions: 2, version: '1' });
  const b = storage.createEmbeddingSpace({ provider: 'x', model: 'b', dimensions: 2, version: '1' });
  const ja = storage.enqueueJob({ documentId: doc.id, revisionId: revision.id, jobType: 'embed', embeddingSpaceId: a.id });
  const ja2 = storage.enqueueJob({ documentId: doc.id, revisionId: revision.id, jobType: 'embed', embeddingSpaceId: a.id });
  const jb = storage.enqueueJob({ documentId: doc.id, revisionId: revision.id, jobType: 'embed', embeddingSpaceId: b.id });
  assert.equal(ja.id, ja2.id);
  assert.notEqual(ja.id, jb.id);
  const claimed = storage.claimJob({ workerId: 'worker-1' });
  assert.equal(claimed.id, ja.id);
  storage.failJob(claimed.id, 'temporary', true);
  assert.equal(storage.readJob(claimed.id).state, 'RETRY_WAIT');
  db.close();
});

test('soft deletion cleans FTS/vector rows and prevents activation', () => {
  const { db, storage } = makeVectorStorage();
  const { doc, revision, chunk } = seedRevision(storage, 'delete');
  const space = storage.createEmbeddingSpace({ provider: 'x', model: 'm', dimensions: 2, version: '1' });
  storage.storeEmbedding(chunk.id, space.id, [1, 0]);
  storage.setStatus(doc.id, revision.id, 'READY', { chunkCount: 1 });
  storage.activateRevision(doc.id, revision.id);
  storage.softDeleteDocument(doc.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_chunks_fts WHERE document_id = ?').get(doc.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_embeddings WHERE chunk_id = ?').get(chunk.id).n, 0);
  assert.throws(() => storage.activateRevision(doc.id, revision.id));
  db.close();
});

test('historical hard deletion requires an explicit retention-policy override', () => {
  const { db, storage } = makeStorage();
  const { doc, revision } = seedRevision(storage, 'retention');
  storage.setStatus(doc.id, revision.id, 'READY', { chunkCount: 1 });
  storage.activateRevision(doc.id, revision.id);
  assert.throws(() => storage.hardDeleteRevision(revision.id));
  assert.throws(() => storage.hardDeleteDocument(doc.id));
  db.close();
});

test('stale leases can be reclaimed and obsolete revision jobs can be cancelled', () => {
  const { db, storage } = makeStorage();
  const { doc, revision } = seedRevision(storage, 'lease');
  const job = storage.enqueueJob({ documentId: doc.id, revisionId: revision.id, jobType: 'chunk', availableAt: 0 });
  const claimed = storage.claimJob({ workerId: 'worker-a', now: 1000, leaseMs: 10 });
  assert.equal(claimed.id, job.id);
  const reclaimed = storage.claimJob({ workerId: 'worker-b', now: 1011, leaseMs: 10 });
  assert.equal(reclaimed.id, job.id);
  const changes = storage.cancelObsoleteJobs(doc.id, 'some-newer-revision');
  assert.equal(changes, 1);
  assert.equal(storage.readJob(job.id).state, 'CANCELLED');
  db.close();
});

test('activation requires readiness, preserves prior pointer on failure, and stale activation cannot overwrite newer revision', () => {
  const { db, storage } = makeStorage();
  const first = seedRevision(storage, 'activate-a');
  storage.setStatus(first.doc.id, first.revision.id, 'READY', { chunkCount: 1 });
  storage.activateRevision(first.doc.id, first.revision.id);

  const second = storage.createRevision({ documentId: first.doc.id, contentHash: 'new', extractionVersion: 'e', chunkingVersion: 'c', normalizationVersion: 'n' });
  storage.replaceChunks(first.doc.id, second.id, [{ chunkIndex: 0, text: 'new content', sourceLocator: 'p1:0-20' }]);
  storage.setStatus(first.doc.id, second.id, 'READY', { chunkCount: 1 });
  storage.activateRevision(first.doc.id, second.id);
  assert.equal(storage.readDocument(first.doc.id).currentRevisionId, second.id);

  assert.throws(() => storage.activateRevision(first.doc.id, first.revision.id));
  assert.equal(storage.readDocument(first.doc.id).currentRevisionId, second.id);

  const rolledBack = storage.rollbackRevision(first.doc.id, first.revision.id);
  assert.equal(rolledBack.currentRevisionId, first.revision.id);
  db.close();
});


test('canonical schema preserves the existing legacy rag_index_status table and does not create rag_sources', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE rag_index_status (source_type TEXT NOT NULL, document_id TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(source_type, document_id));`);
  installCanonicalRagSchema(db);
  const legacy = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='rag_index_status'").get().sql;
  assert.match(legacy, /PRIMARY KEY\(source_type, document_id\)/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='rag_sources'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='rag_canonical_index_status'").get().n, 1);
  db.close();
});

test('vector consistency reports orphan rows in the canonical space', () => {
  const { db, storage } = makeVectorStorage();
  const space = storage.createEmbeddingSpace({ provider: 'x', model: 'orphan', dimensions: 2, version: '1' });
  storage.rebuildVectorIndex(space.id);
  db.prepare(`INSERT INTO vec_rag_embeddings_${space.vectorTableKey} (rowid, embedding) VALUES (?, ?)`).run(BigInt(999999), Buffer.from(new Float32Array([1, 0]).buffer));
  const report = storage.checkVectorIndex(space.id);
  assert.equal(report.orphanVectorRows, 1);
  db.close();
});

test('canonical lexical search filters deleted, superseded, source and scope state', () => {
  const { db, storage } = makeStorage();

  const current = storage.createDocument({ sourceType: 'personal', sourceId: 'current', scopeId: 'scope-a', name: 'Current' });
  const currentRevision = storage.createRevision({ documentId: current.id, contentHash: 'current-v1', extractionVersion: 'e', chunkingVersion: 'c', normalizationVersion: 'n' });
  storage.replaceChunks(current.id, currentRevision.id, [{ chunkIndex: 0, text: 'needle current old', sourceLocator: 'current-old' }]);
  storage.setStatus(current.id, currentRevision.id, 'EMBEDDING');
  storage.setStatus(current.id, currentRevision.id, 'READY', { chunkCount: 1, embeddedChunkCount: 0 });
  storage.activateRevision(current.id, currentRevision.id);

  const activeRevision = storage.createRevision({ documentId: current.id, contentHash: 'current-v2', extractionVersion: 'e', chunkingVersion: 'c', normalizationVersion: 'n' });
  storage.replaceChunks(current.id, activeRevision.id, [{ chunkIndex: 0, text: 'needle current active', sourceLocator: 'current-active' }]);
  storage.setStatus(current.id, activeRevision.id, 'EMBEDDING');
  storage.setStatus(current.id, activeRevision.id, 'READY', { chunkCount: 1, embeddedChunkCount: 0 });
  storage.activateRevision(current.id, activeRevision.id);

  const deleted = storage.createDocument({ sourceType: 'personal', sourceId: 'deleted', scopeId: 'scope-a', name: 'Deleted' });
  const deletedRevision = storage.createRevision({ documentId: deleted.id, contentHash: 'deleted-v1', extractionVersion: 'e', chunkingVersion: 'c', normalizationVersion: 'n' });
  storage.replaceChunks(deleted.id, deletedRevision.id, [{ chunkIndex: 0, text: 'needle deleted', sourceLocator: 'deleted' }]);
  storage.setStatus(deleted.id, deletedRevision.id, 'EMBEDDING');
  storage.setStatus(deleted.id, deletedRevision.id, 'READY', { chunkCount: 1, embeddedChunkCount: 0 });
  storage.activateRevision(deleted.id, deletedRevision.id);
  db.prepare('UPDATE rag_documents SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), deleted.id);

  const otherScope = storage.createDocument({ sourceType: 'personal', sourceId: 'other', scopeId: 'scope-b', name: 'Other Scope' });
  const otherRevision = storage.createRevision({ documentId: otherScope.id, contentHash: 'other-v1', extractionVersion: 'e', chunkingVersion: 'c', normalizationVersion: 'n' });
  storage.replaceChunks(otherScope.id, otherRevision.id, [{ chunkIndex: 0, text: 'needle other scope', sourceLocator: 'other' }]);
  storage.setStatus(otherScope.id, otherRevision.id, 'EMBEDDING');
  storage.setStatus(otherScope.id, otherRevision.id, 'READY', { chunkCount: 1, embeddedChunkCount: 0 });
  storage.activateRevision(otherScope.id, otherRevision.id);

  const notReady = storage.createDocument({ sourceType: 'personal', sourceId: 'not-ready', scopeId: 'scope-a', name: 'Not Ready' });
  const notReadyRevision = storage.createRevision({ documentId: notReady.id, contentHash: 'not-ready-v1', extractionVersion: 'e', chunkingVersion: 'c', normalizationVersion: 'n' });
  storage.replaceChunks(notReady.id, notReadyRevision.id, [{ chunkIndex: 0, text: 'needle not ready', sourceLocator: 'not-ready' }]);

  const differentSource = storage.createDocument({ sourceType: 'mode', sourceId: 'mode-source', scopeId: 'scope-a', name: 'Mode Source' });
  const differentSourceRevision = storage.createRevision({ documentId: differentSource.id, contentHash: 'mode-v1', extractionVersion: 'e', chunkingVersion: 'c', normalizationVersion: 'n' });
  storage.replaceChunks(differentSource.id, differentSourceRevision.id, [{ chunkIndex: 0, text: 'needle different source', sourceLocator: 'mode' }]);
  storage.setStatus(differentSource.id, differentSourceRevision.id, 'EMBEDDING');
  storage.setStatus(differentSource.id, differentSourceRevision.id, 'READY', { chunkCount: 1, embeddedChunkCount: 0 });
  storage.activateRevision(differentSource.id, differentSourceRevision.id);

  const results = storage.searchLexical('needle', { sourceType: 'personal', scopeId: 'scope-a', limit: 20 });
  assert.equal(results.length, 1);
  assert.equal(results[0].document.id, current.id);
  assert.equal(results[0].chunk.revisionId, activeRevision.id);

  const sourceFiltered = storage.searchLexical('needle', { sourceType: 'personal', sourceId: 'other', limit: 20 });
  assert.equal(sourceFiltered.length, 1);
  assert.equal(sourceFiltered[0].document.id, otherScope.id);

  const notReadyResults = storage.searchLexical('needle', { sourceType: 'personal', scopeId: 'scope-a', limit: 20 });
  assert.ok(notReadyResults.every((result) => result.document.id !== notReady.id));
  assert.ok(notReadyResults.every((result) => result.document.sourceType === 'personal'));

  db.close();
});

test('canonical sqlite-vec search proves MATCH distance ordering LIMIT physical row mapping and lifecycle filtering', () => {
  const { db, storage } = makeVectorStorage();
  const space = storage.createEmbeddingSpace({ provider: 'test', model: 'test-model', dimensions: 2, version: '1' });
  const otherSpace = storage.createEmbeddingSpace({ provider: 'test', model: 'other-model', dimensions: 2, version: '1' });

  const far = storage.createDocument({ sourceType: 'personal', sourceId: 'far', scopeId: 'scope-a', name: 'Far' });
  const farRevision = storage.createRevision({ documentId: far.id, contentHash: 'far-v1', extractionVersion: 'e', chunkingVersion: 'c', normalizationVersion: 'n' });
  storage.replaceChunks(far.id, farRevision.id, [{ chunkIndex: 0, text: 'far vector', sourceLocator: 'far' }]);
  const farChunk = storage.readChunks(farRevision.id)[0];
  const farEmbedding = storage.storeEmbedding(farChunk.id, space.id, [0, 1]);
  storage.setStatus(far.id, farRevision.id, 'EMBEDDING');
  storage.setStatus(far.id, farRevision.id, 'READY', { chunkCount: 1, embeddedChunkCount: 1 });
  storage.activateRevision(far.id, farRevision.id, [space.id]);

  const near = storage.createDocument({ sourceType: 'personal', sourceId: 'near', scopeId: 'scope-a', name: 'Near' });
  const nearRevision = storage.createRevision({ documentId: near.id, contentHash: 'near-v1', extractionVersion: 'e', chunkingVersion: 'c', normalizationVersion: 'n' });
  storage.replaceChunks(near.id, nearRevision.id, [{ chunkIndex: 0, text: 'near vector', sourceLocator: 'near' }]);
  const nearChunk = storage.readChunks(nearRevision.id)[0];
  const nearEmbedding = storage.storeEmbedding(nearChunk.id, space.id, [1, 0]);
  storage.storeEmbedding(nearChunk.id, otherSpace.id, [1, 0]);
  storage.setStatus(near.id, nearRevision.id, 'EMBEDDING');
  storage.setStatus(near.id, nearRevision.id, 'READY', { chunkCount: 1, embeddedChunkCount: 1 });
  storage.activateRevision(near.id, nearRevision.id, [space.id]);

  const superseded = storage.createDocument({ sourceType: 'personal', sourceId: 'superseded', scopeId: 'scope-a', name: 'Superseded' });
  const oldRevision = storage.createRevision({ documentId: superseded.id, contentHash: 'superseded-v1', extractionVersion: 'e', chunkingVersion: 'c', normalizationVersion: 'n' });
  storage.replaceChunks(superseded.id, oldRevision.id, [{ chunkIndex: 0, text: 'old revision vector', sourceLocator: 'old' }]);
  const oldChunk = storage.readChunks(oldRevision.id)[0];
  storage.storeEmbedding(oldChunk.id, space.id, [1, 0]);
  storage.setStatus(superseded.id, oldRevision.id, 'EMBEDDING');
  storage.setStatus(superseded.id, oldRevision.id, 'READY', { chunkCount: 1, embeddedChunkCount: 1 });
  storage.activateRevision(superseded.id, oldRevision.id, [space.id]);

  const currentRevision = storage.createRevision({ documentId: superseded.id, contentHash: 'superseded-v2', extractionVersion: 'e', chunkingVersion: 'c', normalizationVersion: 'n' });
  storage.replaceChunks(superseded.id, currentRevision.id, [{ chunkIndex: 0, text: 'current revision vector', sourceLocator: 'current' }]);
  const currentChunk = storage.readChunks(currentRevision.id)[0];
  const currentEmbedding = storage.storeEmbedding(currentChunk.id, space.id, [0.9, 0.1]);
  storage.setStatus(superseded.id, currentRevision.id, 'EMBEDDING');
  storage.setStatus(superseded.id, currentRevision.id, 'READY', { chunkCount: 1, embeddedChunkCount: 1 });
  storage.activateRevision(superseded.id, currentRevision.id, [space.id]);

  const notReady = storage.createDocument({ sourceType: 'personal', sourceId: 'not-ready', scopeId: 'scope-a', name: 'Not Ready' });
  const notReadyRevision = storage.createRevision({ documentId: notReady.id, contentHash: 'not-ready-v1', extractionVersion: 'e', chunkingVersion: 'c', normalizationVersion: 'n' });
  storage.replaceChunks(notReady.id, notReadyRevision.id, [{ chunkIndex: 0, text: 'not ready vector', sourceLocator: 'not-ready' }]);
  const notReadyChunk = storage.readChunks(notReadyRevision.id)[0];
  storage.storeEmbedding(notReadyChunk.id, space.id, [1, 0]);

  const deleted = storage.createDocument({ sourceType: 'personal', sourceId: 'deleted', scopeId: 'scope-a', name: 'Deleted' });
  const deletedRevision = storage.createRevision({ documentId: deleted.id, contentHash: 'deleted-v1', extractionVersion: 'e', chunkingVersion: 'c', normalizationVersion: 'n' });
  storage.replaceChunks(deleted.id, deletedRevision.id, [{ chunkIndex: 0, text: 'deleted vector', sourceLocator: 'deleted' }]);
  const deletedChunk = storage.readChunks(deletedRevision.id)[0];
  storage.storeEmbedding(deletedChunk.id, space.id, [1, 0]);
  storage.setStatus(deleted.id, deletedRevision.id, 'EMBEDDING');
  storage.setStatus(deleted.id, deletedRevision.id, 'READY', { chunkCount: 1, embeddedChunkCount: 1 });
  storage.activateRevision(deleted.id, deletedRevision.id, [space.id]);
  db.prepare('UPDATE rag_documents SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), deleted.id);

  const otherScope = storage.createDocument({ sourceType: 'personal', sourceId: 'other-scope', scopeId: 'scope-b', name: 'Other Scope' });
  const otherScopeRevision = storage.createRevision({ documentId: otherScope.id, contentHash: 'other-scope-v1', extractionVersion: 'e', chunkingVersion: 'c', normalizationVersion: 'n' });
  storage.replaceChunks(otherScope.id, otherScopeRevision.id, [{ chunkIndex: 0, text: 'other scope vector', sourceLocator: 'other-scope' }]);
  const otherScopeChunk = storage.readChunks(otherScopeRevision.id)[0];
  storage.storeEmbedding(otherScopeChunk.id, space.id, [1, 0]);
  storage.setStatus(otherScope.id, otherScopeRevision.id, 'EMBEDDING');
  storage.setStatus(otherScope.id, otherScopeRevision.id, 'READY', { chunkCount: 1, embeddedChunkCount: 1 });
  storage.activateRevision(otherScope.id, otherScopeRevision.id, [space.id]);

  const results = storage.searchVector([1, 0], { embeddingSpaceId: space.id, sourceType: 'personal', scopeId: 'scope-a', limit: 20 });
  const resultIds = results.map((result) => result.chunk.id);
  assert.ok(resultIds.includes(nearChunk.id));
  assert.ok(resultIds.includes(currentChunk.id));
  assert.ok(!resultIds.includes(farChunk.id) || results.find((result) => result.chunk.id === nearChunk.id).distance <= results.find((result) => result.chunk.id === farChunk.id).distance);
  assert.ok(!resultIds.includes(oldChunk.id));
  assert.ok(!resultIds.includes(notReadyChunk.id));
  assert.ok(!resultIds.includes(deletedChunk.id));
  assert.ok(!resultIds.includes(otherScopeChunk.id));
  assert.ok(results.every((result) => result.embeddingSpaceId === space.id));
  assert.equal(results.find((result) => result.chunk.id === nearChunk.id).physicalRowKey, Number(nearEmbedding.physicalRowKey));
  assert.equal(results.find((result) => result.chunk.id === currentChunk.id).physicalRowKey, Number(currentEmbedding.physicalRowKey));
  assert.equal(results.find((result) => result.chunk.id === nearChunk.id).physicalRowKey, Number(db.prepare('SELECT physical_row_key FROM rag_embeddings WHERE chunk_id = ? AND embedding_space_id = ?').get(nearChunk.id, space.id).physical_row_key));
  assert.ok(results.every((result) => result.distance >= 0));

  const ordered = storage.searchVector([1, 0], { embeddingSpaceId: space.id, sourceType: 'personal', scopeId: 'scope-a', limit: 2 });
  assert.equal(ordered.length, 2);
  assert.equal(ordered[0].chunk.id, nearChunk.id);
  assert.ok(ordered[0].distance < ordered[1].distance);

  const limited = storage.searchVector([1, 0], { embeddingSpaceId: space.id, sourceType: 'personal', scopeId: 'scope-a', limit: 1 });
  assert.equal(limited.length, 1);
  assert.equal(limited[0].chunk.id, nearChunk.id);

  const rawVectorRows = db.prepare(`SELECT rowid AS physical_row_key FROM vec_rag_embeddings_${space.vectorTableKey} WHERE rowid IN (?, ?)`).all(BigInt(Number(nearEmbedding.physicalRowKey)), BigInt(Number(farEmbedding.physicalRowKey)));
  assert.equal(rawVectorRows.length, 2);

  db.close();
});
