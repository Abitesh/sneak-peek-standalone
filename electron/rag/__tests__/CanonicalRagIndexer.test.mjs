import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { installCanonicalRagSchema } from '../../../dist-electron/electron/rag/canonical/CanonicalRagSchema.js';
import { CanonicalRagStorage } from '../../../dist-electron/electron/rag/canonical/CanonicalRagStorage.js';
import { CanonicalEmbeddingService } from '../../../dist-electron/electron/rag/canonical/CanonicalEmbeddingService.js';
import { CanonicalRagIndexer } from '../../../dist-electron/electron/rag/canonical/CanonicalRagIndexer.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  let ext = sqliteVec.getLoadablePath();
  ext = ext.replace('app.asar', 'app.asar.unpacked').replace(/\.(dylib|so|dll)$/, '');
  db.loadExtension(ext);
  installCanonicalRagSchema(db);
  return db;
}

function seed(storage, suffix = '1') {
  const document = storage.createDocument({
    sourceType: 'personal',
    sourceId: `canonical-index-${suffix}`,
    name: `Canonical index ${suffix}`,
  });
  const revision = storage.createRevision({
    documentId: document.id,
    contentHash: `hash-${suffix}`,
    extractionVersion: 'extract-v1',
    chunkingVersion: 'chunk-v1',
    normalizationVersion: 'norm-v1',
    extractionState: 'EXTRACTED',
  });
  storage.replaceChunks(document.id, revision.id, [
    { chunkIndex: 0, text: 'first canonical chunk', sourceLocator: 'p1:0-20', pageStart: 1, pageEnd: 1 },
    { chunkIndex: 1, text: 'second canonical chunk', sourceLocator: 'p2:0-21', pageStart: 2, pageEnd: 2 },
  ]);
  return { document, revision };
}

function makeIndexer(storage, vectors = [[1, 0, 0], [0, 1, 0]]) {
  const provider = {
    provider: 'local',
    model: 'test-model',
    dimensions: 3,
    version: 'test-v1',
    async embedBatch(texts) {
      return texts.map((_, index) => vectors[index] ?? [0, 0, 1]);
    },
  };
  const embedding = new CanonicalEmbeddingService(storage, provider);
  return new CanonicalRagIndexer(storage, embedding);
}

test('universal indexer runs canonical chunks through FTS, embedding, vector verification, and READY', async () => {
  const db = makeDb();
  const storage = new CanonicalRagStorage(db);
  const { document, revision } = seed(storage, 'full');
  const indexer = makeIndexer(storage);

  const result = await indexer.indexRevision(revision.id, { workerId: 'indexer-test' });

  assert.equal(result.documentId, document.id);
  assert.equal(result.revisionId, revision.id);
  assert.equal(result.chunkCount, 2);
  assert.equal(result.embeddedChunkCount, 2);
  assert.equal(result.complete, true);
  assert.equal(result.activated, true);
  assert.equal(storage.getStatus(document.id, revision.id).status, 'READY');
  assert.deepEqual(storage.checkFts(revision.id), { expected: 2, actual: 2, missing: 0 });
  const space = storage.readEmbeddingSpace(result.embeddingSpaceId);
  assert.equal(storage.checkVectorIndexForRevision(space.id, revision.id).missingVectorRows, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM rag_index_jobs WHERE revision_id = ? AND state = 'COMPLETED'`).get(revision.id).n, 2);
  db.close();
});

test('universal indexer is idempotent once the revision is READY', async () => {
  const db = makeDb();
  const storage = new CanonicalRagStorage(db);
  const { document, revision } = seed(storage, 'idempotent');
  const indexer = makeIndexer(storage);

  const first = await indexer.indexRevision(revision.id, { workerId: 'indexer-test' });
  const jobsBefore = db.prepare('SELECT COUNT(*) AS n FROM rag_index_jobs WHERE revision_id = ?').get(revision.id).n;
  const second = await indexer.indexRevision(revision.id, { workerId: 'indexer-test' });

  assert.equal(second.complete, true);
  assert.equal(second.embeddingSpaceId, first.embeddingSpaceId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_index_jobs WHERE revision_id = ?').get(revision.id).n, jobsBefore);
  assert.equal(storage.readDocument(document.id).currentRevisionId, revision.id);
  db.close();
});

test('embedding failure is recorded as recoverable job failure and a later run can finish', async () => {
  const db = makeDb();
  const storage = new CanonicalRagStorage(db);
  const { document, revision } = seed(storage, 'retry');
  let shouldFail = true;
  const provider = {
    provider: 'local',
    model: 'retry-model',
    dimensions: 3,
    version: 'test-v1',
    async embedBatch(texts) {
      if (shouldFail) throw new Error('temporary provider failure');
      return texts.map((_, index) => index === 0 ? [1, 0, 0] : [0, 1, 0]);
    },
  };
  const indexer = new CanonicalRagIndexer(storage, new CanonicalEmbeddingService(storage, provider));

  const failed = await indexer.indexRevision(revision.id, { workerId: 'indexer-test' });
  assert.equal(failed.complete, false);
  assert.equal(storage.getStatus(document.id, revision.id).status, 'FAILED');
  const failedJob = db.prepare(`SELECT * FROM rag_index_jobs WHERE revision_id = ? AND job_type = 'embed'`).get(revision.id);
  assert.equal(failedJob.state, 'RETRY_WAIT');

  shouldFail = false;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const recovered = await indexer.indexRevision(revision.id, { workerId: 'indexer-test' });
  assert.equal(recovered.complete, true);
  assert.equal(storage.getStatus(document.id, revision.id).status, 'READY');
  assert.equal(storage.readDocument(document.id).currentRevisionId, revision.id);
  db.close();
});

test('specific job claiming and lease ownership prevent stale workers from completing reclaimed jobs', () => {
  const db = makeDb();
  const storage = new CanonicalRagStorage(db);
  const { document, revision } = seed(storage, 'lease');
  const job = storage.enqueueJob({ documentId: document.id, revisionId: revision.id, jobType: 'rebuild_fts', availableAt: 0 });

  const first = storage.claimSpecificJob(job.id, { workerId: 'worker-a', now: 1000, leaseMs: 10 });
  assert.equal(first.leasedBy, 'worker-a');
  assert.equal(storage.claimSpecificJob(job.id, { workerId: 'worker-b', now: 1005, leaseMs: 10 }), null);

  const reclaimed = storage.claimSpecificJob(job.id, { workerId: 'worker-b', now: 1011, leaseMs: 10 });
  assert.equal(reclaimed.leasedBy, 'worker-b');
  assert.throws(() => storage.completeJob(job.id, 'worker-a'), /leased by another worker/);
  storage.completeJob(job.id, 'worker-b');
  assert.equal(storage.readJob(job.id).state, 'COMPLETED');
  db.close();
});
