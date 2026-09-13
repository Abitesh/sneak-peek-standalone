import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { installCanonicalRagSchema } from '../../../dist-electron/electron/rag/canonical/CanonicalRagSchema.js';
import { CanonicalRagStorage } from '../../../dist-electron/electron/rag/canonical/CanonicalRagStorage.js';
import { CanonicalEmbeddingService } from '../../../dist-electron/electron/rag/canonical/CanonicalEmbeddingService.js';

function makeStorage() {
  const db = new Database(':memory:');
  db.loadExtension(sqliteVec.getLoadablePath());
  installCanonicalRagSchema(db);
  return { db, storage: new CanonicalRagStorage(db) };
}

function seedRevision(storage, sourceId = 'source') {
  const doc = storage.createDocument({
    sourceType: 'personal',
    sourceId,
    name: `${sourceId}.txt`,
  });
  const revision = storage.createRevision({
    documentId: doc.id,
    contentHash: `hash-${sourceId}`,
    extractionVersion: 'extract-1',
    chunkingVersion: 'chunk-1',
    normalizationVersion: 'norm-1',
  });
  storage.replaceChunks(doc.id,revision.id, [
    { chunkIndex: 0, text: 'first canonical chunk', sourceLocator: '0' },
    { chunkIndex: 1, text: 'second canonical chunk', sourceLocator: '1' },
    { chunkIndex: 2, text: 'third canonical chunk', sourceLocator: '2' },
  ]);
  return { doc, revision };
}

function provider(overrides = {}) {
  return {
    provider: 'test-provider',
    model: 'test-model',
    dimensions: 2,
    version: '1',
    async embedBatch(texts) {
      return texts.map((_, index) => [index + 1, 0]);
    },
    ...overrides,
  };
}

test('embeds canonical revision without source-specific branches', async () => {
  const { db, storage } = makeStorage();
  const { doc, revision } = seedRevision(storage, 'generic');
  const service = new CanonicalEmbeddingService(storage, provider());

  const result = await service.embedRevision(revision.id, { batchSize: 2 });

  assert.equal(result.documentId, doc.id);
  assert.equal(result.chunkCount, 3);
  assert.equal(result.embeddedCount, 3);
  assert.equal(result.complete, true);
  assert.equal(storage.listEmbeddingSpaces().length, 1);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM rag_embeddings WHERE embedding_space_id = ?').get(result.embeddingSpaceId).n,
    3,
  );
  assert.equal(storage.checkVectorIndex(result.embeddingSpaceId).missingVectorRows, 0);
  db.close();
});

test('reuses one embedding space across independent documents', async () => {
  const { db, storage } = makeStorage();
  const first = seedRevision(storage, 'one');
  const second = seedRevision(storage, 'two');
  const service = new CanonicalEmbeddingService(storage, provider());

  const a = await service.embedRevision(first.revision.id);
  const b = await service.embedRevision(second.revision.id);

  assert.equal(a.embeddingSpaceId, b.embeddingSpaceId);
  assert.equal(storage.listEmbeddingSpaces().length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_embeddings').get().n, 6);
  db.close();
});

test('embedding model change creates a new space without changing chunk identity', async () => {
  const { db, storage } = makeStorage();
  const { revision } = seedRevision(storage, 'model-change');
  const first = new CanonicalEmbeddingService(storage, provider({ model: 'model-a' }));
  const second = new CanonicalEmbeddingService(storage, provider({ model: 'model-b' }));

  const a = await first.embedRevision(revision.id);
  const b = await second.embedRevision(revision.id);

  assert.notEqual(a.embeddingSpaceId, b.embeddingSpaceId);
  assert.equal(storage.readChunks(revision.id).length, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_embeddings').get().n, 6);
  db.close();
});

test('requested canonical space must exactly match provider identity', async () => {
  const { db, storage } = makeStorage();
  const { revision } = seedRevision(storage, 'mismatch');
  const serviceA = new CanonicalEmbeddingService(storage, provider({ model: 'model-a' }));
  const serviceB = new CanonicalEmbeddingService(storage, provider({ model: 'model-b' }));
  const space = serviceA.ensureEmbeddingSpace();

  await assert.rejects(
    serviceB.embedRevision(revision.id, { embeddingSpaceId: space.id }),
    /does not match the requested canonical embedding space/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_embeddings').get().n, 0);
  db.close();
});

test('provider failure keeps successful prefix and reports incomplete', async () => {
  const { db, storage } = makeStorage();
  const { revision } = seedRevision(storage, 'partial');
  let calls = 0;
  const service = new CanonicalEmbeddingService(storage, provider({
    async embedBatch(texts) {
      calls += 1;
      if (calls === 2) throw new Error('provider unavailable');
      return texts.map(() => [1, 0]);
    },
  }));

  const result = await service.embedRevision(revision.id, { batchSize: 2 });

  assert.equal(result.embeddedCount, 2);
  assert.equal(result.complete, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_embeddings').get().n, 2);
  db.close();
});

test('empty revision is a successful no-op', async () => {
  const { db, storage } = makeStorage();
  const doc = storage.createDocument({ sourceType: 'personal', sourceId: 'empty', name: 'empty.txt' });
  const revision = storage.createRevision({
    documentId: doc.id,
    contentHash: 'empty-hash',
    extractionVersion: 'extract-1',
    chunkingVersion: 'chunk-1',
    normalizationVersion: 'norm-1',
  });
  const service = new CanonicalEmbeddingService(storage, provider());

  const result = await service.embedRevision(revision.id);

  assert.equal(result.chunkCount, 0);
  assert.equal(result.embeddedCount, 0);
  assert.equal(result.complete, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_embeddings').get().n, 0);
  db.close();
});
