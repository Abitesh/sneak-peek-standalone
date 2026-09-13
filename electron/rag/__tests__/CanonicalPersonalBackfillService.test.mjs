import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { installCanonicalRagSchema } from '../../../dist-electron/electron/rag/canonical/CanonicalRagSchema.js';
import { CanonicalRagStorage } from '../../../dist-electron/electron/rag/canonical/CanonicalRagStorage.js';
import { CanonicalRagIndexer } from '../../../dist-electron/electron/rag/canonical/CanonicalRagIndexer.js';
import { CanonicalEmbeddingService } from '../../../dist-electron/electron/rag/canonical/CanonicalEmbeddingService.js';
import { CanonicalPersonalRagService } from '../../../dist-electron/electron/rag/canonical/CanonicalPersonalRagService.js';
import { CanonicalPersonalBackfillService } from '../../../dist-electron/electron/rag/canonical/CanonicalPersonalBackfillService.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  let ext = sqliteVec.getLoadablePath();
  ext = ext.replace('app.asar', 'app.asar.unpacked').replace(/\.(dylib|so|dll)$/, '');
  db.loadExtension(ext);
  db.exec(`
    CREATE TABLE personal_files (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
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
      content_type TEXT NOT NULL DEFAULT 'text',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      embedding BLOB,
      embedding_provider TEXT,
      embedding_dimensions INTEGER,
      embedding_space TEXT,
      FOREIGN KEY(file_id) REFERENCES personal_files(id) ON DELETE CASCADE
    );
  `);
  installCanonicalRagSchema(db);
  return db;
}

function vectorBuffer(values) {
  const vector = new Float32Array(values);
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function seedPersonal(db, id, contentHash, suffix = '') {
  db.prepare(`INSERT INTO personal_files
    (id, file_name, file_path, mime_type, size_bytes, content_hash, created_at, updated_at, file_type, page_count, extracted_page_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, `resume${suffix}.pdf`, `/personal/resume${suffix}.pdf`, 'application/pdf', 100,
      contentHash, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'resume', 2, 2,
    );
  const insert = db.prepare(`INSERT INTO personal_file_chunks
    (id, file_id, chunk_index, text, start_char, end_char, page_start, page_end, section, heading, content_type, metadata_json, embedding, embedding_provider, embedding_dimensions, embedding_space)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run(`${id}-c0`, id, 0, 'Alpha personal', 0, 15, 1, 1, 'Intro', 'Alpha', 'text', '{"custom":"a"}', vectorBuffer([1, 0, 0]), 'local', 3, 'local:test-model:3');
  insert.run(`${id}-c1`, id, 1, 'Beta personal', 16, 29, 2, 2, 'Body', 'Beta', 'text', '{"custom":"b"}', vectorBuffer([0, 1, 0]), 'local', 3, 'local:test-model:3');
}

function makeFixture() {
  const db = makeDb();
  const storage = new CanonicalRagStorage(db);
  const personalStorage = {
    readDocument(id) {
      const row = db.prepare('SELECT * FROM personal_files WHERE id = ?').get(id);
      if (!row) return null;
      return {
        id: row.id,
        name: row.file_name,
        path: row.file_path,
        mimeType: row.mime_type,
        metadata: {
          contentHash: row.content_hash,
          sizeBytes: row.size_bytes,
          fileType: row.file_type,
        },
      };
    },
    readChunks(id) {
      return db.prepare('SELECT * FROM personal_file_chunks WHERE file_id = ? ORDER BY chunk_index').all(id).map((row) => ({
        id: row.id,
        chunkIndex: row.chunk_index,
        text: row.text,
        startOffset: row.start_char,
        endOffset: row.end_char,
        pageStart: row.page_start,
        pageEnd: row.page_end,
        section: row.section,
        heading: row.heading,
        metadata: { ...JSON.parse(row.metadata_json), contentType: row.content_type },
      }));
    },
  };
  const provider = {
    provider: 'local',
    model: 'test-model',
    dimensions: 3,
    version: 'test-v1',
    async embedBatch(texts) {
      return texts.map((text) => text.startsWith('Alpha') ? [1, 0, 0] : [0, 1, 0]);
    },
  };
  const embeddingService = new CanonicalEmbeddingService(storage, provider);
  const indexer = new CanonicalRagIndexer(storage, embeddingService);
  const canonicalPersonal = new CanonicalPersonalRagService(storage, personalStorage, embeddingService, indexer);
  const personalKnowledge = { listFiles: () => db.prepare('SELECT id FROM personal_files ORDER BY id').all().map((row) => ({ id: row.id })) };
  const backfill = new CanonicalPersonalBackfillService(personalKnowledge, canonicalPersonal);
  return { db, backfill };
}

test('Personal backfill enumerates files and uses the universal canonical indexer', async () => {
  const { db, backfill } = makeFixture();
  seedPersonal(db, 'pfile-1', 'hash-1');
  const before = db.prepare('SELECT * FROM personal_file_chunks ORDER BY id').all();
  const summary = await backfill.backfillAll();
  assert.equal(summary.attempted, 1);
  assert.equal(summary.completed, 1);
  assert.equal(summary.failed, 0);
  const result = summary.results[0];
  assert.equal(result.complete, true);
  assert.equal(result.activated, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_documents WHERE source_type = ?').get('personal').n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_chunks WHERE revision_id = ?').get(result.revisionId).n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_embeddings WHERE embedding_space_id = ?').get(result.embeddingSpaceId).n, 2);
  const status = db.prepare('SELECT status FROM rag_canonical_index_status WHERE document_id = ? AND revision_id = ?').get(result.documentId, result.revisionId);
  assert.equal(status.status, 'READY');
  assert.deepEqual(db.prepare('SELECT * FROM personal_file_chunks ORDER BY id').all(), before);
  db.close();
});

test('Personal backfill is idempotent for unchanged files', async () => {
  const { db, backfill } = makeFixture();
  seedPersonal(db, 'pfile-idempotent', 'hash-idempotent');
  const first = await backfill.backfillFile('pfile-idempotent');
  const counts = {
    documents: db.prepare('SELECT COUNT(*) AS n FROM rag_documents').get().n,
    revisions: db.prepare('SELECT COUNT(*) AS n FROM rag_document_revisions').get().n,
    chunks: db.prepare('SELECT COUNT(*) AS n FROM rag_chunks').get().n,
  };
  const second = await backfill.backfillFile('pfile-idempotent');
  assert.equal(second.documentId, first.documentId);
  assert.equal(second.revisionId, first.revisionId);
  assert.deepEqual({
    documents: db.prepare('SELECT COUNT(*) AS n FROM rag_documents').get().n,
    revisions: db.prepare('SELECT COUNT(*) AS n FROM rag_document_revisions').get().n,
    chunks: db.prepare('SELECT COUNT(*) AS n FROM rag_chunks').get().n,
  }, counts);
  db.close();
});

test('Personal backfill creates a new canonical revision when legacy content changes', async () => {
  const { db, backfill } = makeFixture();
  seedPersonal(db, 'pfile-revision', 'hash-old');
  const first = await backfill.backfillFile('pfile-revision');
  db.prepare('UPDATE personal_files SET content_hash = ?, updated_at = ? WHERE id = ?').run('hash-new', '2026-09-02T00:00:00.000Z', 'pfile-revision');
  db.prepare('UPDATE personal_file_chunks SET text = ? WHERE id = ?').run('Gamma personal', 'pfile-revision-c1');
  const second = await backfill.backfillFile('pfile-revision');
  assert.notEqual(second.revisionId, first.revisionId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_document_revisions WHERE document_id = ?').get(first.documentId).n, 2);
  assert.equal(db.prepare('SELECT current_revision_id FROM rag_documents WHERE id = ?').get(first.documentId).current_revision_id, second.revisionId);
  db.close();
});

test('Personal backfill isolates a failed file and leaves legacy rows unchanged', async () => {
  const { db, backfill } = makeFixture();
  seedPersonal(db, 'pfile-good', 'hash-good', '-good');
  const before = db.prepare('SELECT * FROM personal_files ORDER BY id').all();
  backfill.personalKnowledge = { listFiles: () => [{ id: 'pfile-good' }, { id: 'pfile-missing' }] };
  const summary = await backfill.backfillAll();
  assert.equal(summary.attempted, 2);
  assert.equal(summary.completed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.errors[0].fileId, 'pfile-missing');
  assert.deepEqual(db.prepare('SELECT * FROM personal_files ORDER BY id').all(), before);
  db.close();
});
