import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { installCanonicalRagSchema } from '../../../dist-electron/electron/rag/canonical/CanonicalRagSchema.js';
import { CanonicalRagStorage } from '../../../dist-electron/electron/rag/canonical/CanonicalRagStorage.js';
import { CanonicalRagIndexer } from '../../../dist-electron/electron/rag/canonical/CanonicalRagIndexer.js';
import { CanonicalModeBackfillService } from '../../../dist-electron/electron/rag/canonical/CanonicalModeBackfillService.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  let ext = sqliteVec.getLoadablePath();
  ext = ext.replace('app.asar', 'app.asar.unpacked').replace(/\.(dylib|so|dll)$/, '');
  db.loadExtension(ext);
  db.exec(`
    CREATE TABLE mode_reference_files (
      id TEXT PRIMARY KEY,
      mode_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      page_count INTEGER,
      extracted_page_count INTEGER
    );
    CREATE TABLE mode_reference_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB,
      embedding_space TEXT,
      created_at INTEGER NOT NULL,
      page_start INTEGER,
      page_end INTEGER,
      section TEXT,
      heading TEXT,
      content_type TEXT NOT NULL DEFAULT 'text',
      table_index INTEGER,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(file_id, chunk_index),
      FOREIGN KEY(file_id) REFERENCES mode_reference_files(id) ON DELETE CASCADE
    );
  `);
  installCanonicalRagSchema(db);
  return db;
}

function vectorBuffer(values) {
  const vector = new Float32Array(values);
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function seedMode(db, id = 'ref-mode-1') {
  db.prepare(`INSERT INTO mode_reference_files
    (id, mode_id, file_name, content, created_at, page_count, extracted_page_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, 'mode-1', 'guide.pdf', 'Alpha\nBeta', '2026-09-01T00:00:00.000Z', 2, 2);
  const insert = db.prepare(`INSERT INTO mode_reference_chunks
    (file_id, chunk_index, text, embedding, embedding_space, created_at, page_start, page_end, section, heading, content_type, table_index, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run(id, 0, 'Alpha', vectorBuffer([1, 0, 0]), 'openai:text-embedding-3-small:3', 1, 1, 1, 'Intro', 'Alpha heading', 'text', null, '{"custom":"a"}');
  insert.run(id, 1, 'Beta', vectorBuffer([0, 1, 0]), 'openai:text-embedding-3-small:3', 2, 2, 2, 'Body', 'Beta heading', 'table', 4, '{"custom":"b"}');
  return id;
}

function makeService(db) {
  const storage = new CanonicalRagStorage(db);
  return new CanonicalModeBackfillService(
    db,
    storage,
    (embeddingService) => new CanonicalRagIndexer(storage, embeddingService),
  );
}

test('Mode backfill creates canonical document/revision/chunks and preserves legacy embeddings', async () => {
  const db = makeDb();
  const fileId = seedMode(db);
  const beforeFiles = db.prepare('SELECT * FROM mode_reference_files').all();
  const beforeChunks = db.prepare('SELECT * FROM mode_reference_chunks ORDER BY id').all();
  const service = makeService(db);

  const result = await service.backfillFile(fileId);
  assert.equal(result.complete, true);
  assert.equal(result.activated, true);
  assert.equal(result.usedLegacyEmbeddings, true);
  assert.equal(result.legacyEmbeddingSpace, 'openai:text-embedding-3-small:3');

  const document = db.prepare('SELECT * FROM rag_documents WHERE source_type = ? AND source_id = ?').get('mode', fileId);
  assert.equal(document.scope_id, 'mode-1');
  assert.equal(document.name, 'guide.pdf');
  const chunks = db.prepare('SELECT * FROM rag_chunks WHERE revision_id = ? ORDER BY chunk_index').all(result.revisionId);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].page_start, 1);
  assert.equal(chunks[0].section, 'Intro');
  assert.equal(chunks[1].heading, 'Beta heading');
  assert.equal(JSON.parse(chunks[1].metadata_json).legacyChunkId, 2);

  const space = db.prepare('SELECT * FROM rag_embedding_spaces WHERE id = ?').get(result.embeddingSpaceId);
  assert.equal(space.provider, 'legacy-mode');
  assert.equal(space.model, 'openai:text-embedding-3-small:3');
  assert.equal(space.dimensions, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_embeddings WHERE embedding_space_id = ?').get(result.embeddingSpaceId).n, 2);

  assert.deepEqual(db.prepare('SELECT * FROM mode_reference_files').all(), beforeFiles);
  assert.deepEqual(db.prepare('SELECT * FROM mode_reference_chunks ORDER BY id').all(), beforeChunks);
  db.close();
});

test('Mode backfill is idempotent for unchanged content', async () => {
  const db = makeDb();
  const fileId = seedMode(db, 'ref-mode-idempotent');
  const service = makeService(db);
  const first = await service.backfillFile(fileId);
  const counts = {
    documents: db.prepare('SELECT COUNT(*) AS n FROM rag_documents').get().n,
    revisions: db.prepare('SELECT COUNT(*) AS n FROM rag_document_revisions').get().n,
    chunks: db.prepare('SELECT COUNT(*) AS n FROM rag_chunks').get().n,
    embeddings: db.prepare('SELECT COUNT(*) AS n FROM rag_embeddings').get().n,
  };
  const second = await service.backfillFile(fileId);
  assert.equal(second.documentId, first.documentId);
  assert.equal(second.revisionId, first.revisionId);
  assert.deepEqual({
    documents: db.prepare('SELECT COUNT(*) AS n FROM rag_documents').get().n,
    revisions: db.prepare('SELECT COUNT(*) AS n FROM rag_document_revisions').get().n,
    chunks: db.prepare('SELECT COUNT(*) AS n FROM rag_chunks').get().n,
    embeddings: db.prepare('SELECT COUNT(*) AS n FROM rag_embeddings').get().n,
  }, counts);
  db.close();
});

test('Mode backfill creates a new canonical revision when legacy content changes', async () => {
  const db = makeDb();
  const fileId = seedMode(db, 'ref-mode-revision');
  const service = makeService(db);
  const first = await service.backfillFile(fileId);
  db.prepare('UPDATE mode_reference_files SET content = ? WHERE id = ?').run('Alpha\nBeta\nGamma', fileId);
  db.prepare('INSERT INTO mode_reference_chunks (file_id, chunk_index, text, embedding, embedding_space, created_at, page_start, page_end, section, heading, content_type, table_index, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(fileId, 2, 'Gamma', vectorBuffer([0, 0, 1]), 'openai:text-embedding-3-small:3', 3, 3, 3, 'Body', 'Gamma heading', 'text', null, '{}');
  const second = await service.backfillFile(fileId);
  assert.notEqual(second.revisionId, first.revisionId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_document_revisions WHERE document_id = ?').get(first.documentId).n, 2);
  assert.equal(db.prepare('SELECT current_revision_id FROM rag_documents WHERE id = ?').get(first.documentId).current_revision_id, second.revisionId);
  db.close();
});

test('Mode backfill can enumerate all files and isolate a failed file', async () => {
  const db = makeDb();
  seedMode(db, 'ref-mode-good');
  db.prepare(`INSERT INTO mode_reference_files (id, mode_id, file_name, content, created_at, page_count, extracted_page_count) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('ref-mode-bad', 'mode-1', 'bad.pdf', 'No embeddings', '2026-09-01T00:00:01.000Z', 1, 1);
  db.prepare(`INSERT INTO mode_reference_chunks (file_id, chunk_index, text, created_at) VALUES (?, ?, ?, ?)`)
    .run('ref-mode-bad', 0, 'No embeddings', 2);
  const service = makeService(db);
  const summary = await service.backfillAll('mode-1');
  assert.equal(summary.attempted, 2);
  assert.equal(summary.completed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.errors[0].fileId, 'ref-mode-bad');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rag_documents WHERE source_id = 'ref-mode-good'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rag_documents WHERE source_id = 'ref-mode-bad'").get().n, 1);
  db.close();
});
