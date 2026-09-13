import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

import { RAGManager } from '../../../dist-electron/electron/rag/RAGManager.js';
import { EmbeddingPipeline } from '../../../dist-electron/electron/rag/EmbeddingPipeline.js';
import { CanonicalRagStorage } from '../../../dist-electron/electron/rag/canonical/CanonicalRagStorage.js';
import { CanonicalEmbeddingService } from '../../../dist-electron/electron/rag/canonical/CanonicalEmbeddingService.js';
import { CanonicalPersonalRagService } from '../../../dist-electron/electron/rag/canonical/CanonicalPersonalRagService.js';
import { installCanonicalRagSchema } from '../../../dist-electron/electron/rag/canonical/CanonicalRagSchema.js';
import { PersonalKnowledgeManager } from '../../../dist-electron/electron/personalKnowledge/PersonalKnowledgeManager.js';

const originalInitialize = EmbeddingPipeline.prototype.initialize;
const originalCanonicalIdentity = EmbeddingPipeline.prototype.getActiveCanonicalEmbeddingIdentity;
const originalGetEmbeddings = EmbeddingPipeline.prototype.getEmbeddingsWithFallback;
const originalProjectPersonalFile = CanonicalPersonalRagService.prototype.projectPersonalFile;

function setupDb() {
  const db = new Database(':memory:');
  db.loadExtension(sqliteVec.getLoadablePath());
  installCanonicalRagSchema(db);
  return db;
}

function installLegacyPersonalSchema(db) {
  db.exec(`
    CREATE TABLE personal_files (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      file_type TEXT NOT NULL DEFAULT 'general',
      page_count INTEGER,
      extracted_page_count INTEGER
    );
    CREATE TABLE personal_file_chunks (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      start_char INTEGER NOT NULL,
      end_char INTEGER NOT NULL,
      page_start INTEGER,
      page_end INTEGER,
      section TEXT,
      heading TEXT,
      content_type TEXT,
      metadata_json TEXT,
      embedding BLOB,
      embedding_provider TEXT,
      embedding_dimensions INTEGER,
      embedding_space TEXT
    );
  `);
}

function fakePersonalStorage() {
  return {
    readDocument(id) {
      return {
        id,
        name: 'resume.txt',
        path: '/tmp/resume.txt',
        mimeType: 'text/plain',
        metadata: { contentHash: 'personal-content-hash', fileType: 'resume', sizeBytes: 42 },
      };
    },
    readChunks() {
      return [
        { id: 'legacy-chunk-1', chunkIndex: 0, text: 'First personal chunk.', startOffset: 0, endOffset: 21, metadata: { contentType: 'text' } },
        { id: 'legacy-chunk-2', chunkIndex: 1, text: 'Second personal chunk.', startOffset: 22, endOffset: 45, metadata: { contentType: 'text' } },
      ];
    },
  };
}

function installEmbeddingStub() {
  EmbeddingPipeline.prototype.initialize = async function initializeStub() {};
  EmbeddingPipeline.prototype.getActiveCanonicalEmbeddingIdentity = function identityStub() {
    return {
      provider: 'local',
      model: 'test-local-model',
      dimensions: 3,
      space: 'local:test-local-model:3',
      version: 'pipeline-v1',
    };
  };
  EmbeddingPipeline.prototype.getEmbeddingsWithFallback = async function embeddingStub(texts) {
    return {
      embeddings: texts.map((_, index) => [index + 0.1, index + 0.2, index + 0.3]),
      space: 'local:test-local-model:3',
      provider: 'local',
      dimensions: 3,
    };
  };
}

function makeManager(db) {
  installEmbeddingStub();
  const manager = new RAGManager({ db, dbPath: ':memory:', extPath: '' });
  return manager;
}

afterEach(() => {
  EmbeddingPipeline.prototype.initialize = originalInitialize;
  EmbeddingPipeline.prototype.getActiveCanonicalEmbeddingIdentity = originalCanonicalIdentity;
  EmbeddingPipeline.prototype.getEmbeddingsWithFallback = originalGetEmbeddings;
  CanonicalPersonalRagService.prototype.projectPersonalFile = originalProjectPersonalFile;
});

test('RAGManager owns and delegates the canonical personal projection service', async () => {
  const db = setupDb();
  try {
    const manager = makeManager(db);
    manager.personalStorage = fakePersonalStorage();

    // RAGManager.js is bundled, so its EmbeddingPipeline class is not necessarily
    // the same module instance imported by this test. Inject a minimal pipeline
    // object directly into this manager to test the delegation boundary without
    // depending on provider initialization.
    const identity = {
      provider: 'local',
      model: 'test-local-model',
      dimensions: 3,
      space: 'local:test-local-model:3',
      version: 'pipeline-v1',
    };
    manager.embeddingPipeline = {
      getActiveCanonicalEmbeddingIdentity() { return identity; },
    };

    let delegated = false;
    const identityKey = [
      identity.provider,
      identity.model,
      identity.dimensions,
      identity.space,
      identity.version,
    ].join('\u001f');

    // Do not patch CanonicalPersonalRagService.prototype here. RAGManager.js is
    // bundled and can contain a separate class module instance. Seed the
    // manager's private cache directly so the production delegation method is
    // exercised without crossing a bundle/module boundary.
    manager.canonicalPersonalEmbeddingIdentityKey = identityKey;
    manager.canonicalPersonalRagService = {
      async projectPersonalFile(personalFileId) {
        delegated = true;
        return {
          personalFileId,
          documentId: 'ragdoc_integration',
          revisionId: 'ragrev_integration',
          embeddingSpaceId: 'rages_integration',
          chunkCount: 2,
          embeddedChunkCount: 2,
          complete: true,
          activated: true,
        };
      },
    };

    const result = await manager.projectPersonalFileCanonical('personal-1');

    assert.equal(delegated, true);
    assert.equal(result.personalFileId, 'personal-1');
    assert.equal(result.documentId, 'ragdoc_integration');
    assert.equal(result.revisionId, 'ragrev_integration');
    assert.equal(result.embeddingSpaceId, 'rages_integration');
    assert.equal(result.complete, true);
    assert.equal(result.activated, true);
  } finally {
    db.close();
  }
});

test('canonical projection preserves legacy personal storage', async () => {
  const db = setupDb();
  try {
    installLegacyPersonalSchema(db);
    db.prepare(`INSERT INTO personal_files
      (id, file_name, file_path, mime_type, size_bytes, content_hash, created_at, updated_at, file_type, page_count, extracted_page_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'personal-2', 'legacy.txt', '/tmp/legacy.txt', 'text/plain', 10,
      'hash-2', '2026-09-13T00:00:00Z', '2026-09-13T00:00:00Z', 'general', null, null,
    );
    db.prepare(`INSERT INTO personal_file_chunks
      (id, file_id, chunk_index, text, start_char, end_char, page_start, page_end, section, heading, content_type, metadata_json, embedding, embedding_provider, embedding_dimensions, embedding_space)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL)`).run(
      'legacy-chunk', 'personal-2', 0, 'Legacy text', 0, 11, 'text', '{}',
    );

    const beforeFile = db.prepare('SELECT * FROM personal_files WHERE id = ?').get('personal-2');
    const beforeChunk = db.prepare('SELECT * FROM personal_file_chunks WHERE file_id = ?').get('personal-2');

    installEmbeddingStub();
    const storage = new CanonicalRagStorage(db);
    const embeddingService = new CanonicalEmbeddingService(storage, {
      provider: 'local', model: 'test-local-model', dimensions: 3, version: 'pipeline-v1',
      async embedBatch(texts) {
        return texts.map((_, index) => [index + 0.1, index + 0.2, index + 0.3]);
      },
    });
    const service = new CanonicalPersonalRagService(storage, fakePersonalStorage(), embeddingService);

    await service.projectPersonalFile('personal-2');

    assert.deepEqual(db.prepare('SELECT * FROM personal_files WHERE id = ?').get('personal-2'), beforeFile);
    assert.deepEqual(db.prepare('SELECT * FROM personal_file_chunks WHERE file_id = ?').get('personal-2'), beforeChunk);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM rag_documents').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM rag_embeddings').get().count, 2);
  } finally {
    db.close();
  }
});

test('PersonalKnowledgeManager canonical projection failure does not roll back legacy ingestion', async () => {
  const db = setupDb();
  installLegacyPersonalSchema(db);
  const tempFile = new URL('./canonical-personal-integration.txt', import.meta.url);
  const fs = await import('node:fs/promises');
  const filePath = tempFile.pathname;

  try {
    await fs.writeFile(filePath, 'A legacy personal document for failure isolation.');

    const manager = new PersonalKnowledgeManager(db);
    const legacyRagManager = {
      setIndexStatus() {},
      async indexDocument(input) {
        const insert = db.prepare(`
          INSERT INTO personal_file_chunks
          (id, file_id, chunk_index, text, start_char, end_char)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        insert.run('legacy-failure-chunk', input.documentId, 0, input.content, 0, input.content.length);
      },
      async projectPersonalFileCanonical() {
        throw new Error('intentional canonical projection failure');
      },
    };
    manager.setRAGManager(legacyRagManager);

    const record = await manager.ingestFile(filePath, 'general');

    assert.ok(record.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM personal_files WHERE id = ?').get(record.id).count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM personal_file_chunks WHERE file_id = ?').get(record.id).count, 1);
    await fs.access(record.filePath);
  } finally {
    await fs.rm(filePath, { force: true });
    db.close();
  }
});
