import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { installCanonicalRagSchema } from '../../../dist-electron/electron/rag/canonical/CanonicalRagSchema.js';
import { CanonicalRagStorage } from '../../../dist-electron/electron/rag/canonical/CanonicalRagStorage.js';
import { CanonicalEmbeddingService } from '../../../dist-electron/electron/rag/canonical/CanonicalEmbeddingService.js';
import { CanonicalRagIndexer } from '../../../dist-electron/electron/rag/canonical/CanonicalRagIndexer.js';
import { CanonicalRagParityVerifier } from '../../../dist-electron/electron/rag/canonical/CanonicalRagParityVerifier.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  let ext = sqliteVec.getLoadablePath();
  ext = ext.replace('app.asar', 'app.asar.unpacked').replace(/\.(dylib|so|dll)$/, '');
  db.loadExtension(ext);
  db.exec(`
    CREATE TABLE mode_reference_files (id TEXT PRIMARY KEY, mode_id TEXT NOT NULL, file_name TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, page_count INTEGER, extracted_page_count INTEGER);
    CREATE TABLE mode_reference_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, text TEXT NOT NULL, embedding BLOB, embedding_space TEXT, created_at INTEGER NOT NULL, page_start INTEGER, page_end INTEGER, section TEXT, heading TEXT, content_type TEXT NOT NULL DEFAULT 'text', table_index INTEGER, metadata_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE personal_files (id TEXT PRIMARY KEY, file_name TEXT NOT NULL, file_path TEXT NOT NULL, mime_type TEXT NOT NULL DEFAULT '', size_bytes INTEGER NOT NULL DEFAULT 0, content_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, file_type TEXT NOT NULL DEFAULT 'general', page_count INTEGER, extracted_page_count INTEGER);
    CREATE TABLE personal_file_chunks (id TEXT PRIMARY KEY, file_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, text TEXT NOT NULL, start_char INTEGER NOT NULL, end_char INTEGER NOT NULL, page_start INTEGER, page_end INTEGER, section TEXT, heading TEXT, content_type TEXT NOT NULL DEFAULT 'text', metadata_json TEXT NOT NULL DEFAULT '{}', embedding BLOB, embedding_provider TEXT, embedding_dimensions INTEGER, embedding_space TEXT);
    CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT, start_time INTEGER, duration_ms INTEGER, summary_json TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, source TEXT, is_processed INTEGER DEFAULT 1);
    CREATE TABLE transcripts (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT, speaker TEXT, content TEXT, timestamp_ms INTEGER);
    CREATE TABLE ai_interactions (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT, type TEXT, timestamp INTEGER, user_query TEXT, ai_response TEXT, metadata_json TEXT);
    CREATE TABLE chunk_summaries (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT UNIQUE, summary_text TEXT NOT NULL, embedding BLOB, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE embedding_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL, chunk_id INTEGER, status TEXT DEFAULT 'pending');
    CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, speaker TEXT, start_timestamp_ms INTEGER, end_timestamp_ms INTEGER, cleaned_text TEXT NOT NULL, token_count INTEGER NOT NULL, embedding BLOB);
    CREATE VIRTUAL TABLE mode_reference_chunks_fts USING fts5(chunk_id UNINDEXED, file_id UNINDEXED, file_name, text);
    CREATE VIRTUAL TABLE personal_file_chunks_fts USING fts5(chunk_id UNINDEXED, file_id UNINDEXED, file_name, text);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(chunk_id UNINDEXED, meeting_id UNINDEXED, speaker, text);
  `);
  installCanonicalRagSchema(db);
  return db;
}

function buf(values) {
  const v = new Float32Array(values);
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

async function indexCanonical(db, documentInput, chunks, vectorByText) {
  const storage = new CanonicalRagStorage(db);
  const document = storage.createDocument(documentInput);
  const hash = documentInput.contentHash;
  const revision = storage.createRevision({ documentId: document.id, contentHash: hash, extractionVersion: 'test-v1', chunkingVersion: 'test-v1', normalizationVersion: 'test-v1', extractionState: 'EXTRACTED' });
  storage.replaceChunks(document.id, revision.id, chunks);
  const provider = { provider: 'local', model: 'test-model', dimensions: 3, version: 'test-v1', async embedBatch(texts) { return texts.map((t) => vectorByText(t)); } };
  const service = new CanonicalEmbeddingService(storage, provider);
  const indexer = new CanonicalRagIndexer(storage, service);
  return { document, revision, result: await indexer.indexRevision(revision.id, { activate: true }) };
}

function seedMode(db) {
  db.prepare(`INSERT INTO mode_reference_files VALUES (?, ?, ?, ?, ?, ?, ?)`).run('ref-1', 'mode-1', 'guide.pdf', 'Alpha\nBeta', '2026-09-01T00:00:00Z', 2, 2);
  db.prepare(`INSERT INTO mode_reference_chunks VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('ref-1', 0, 'Alpha', buf([1,0,0]), 'legacy-space:3', 1, 1, 1, 'Intro', 'Alpha', 'text', null, '{"custom":"a"}');
  db.prepare(`INSERT INTO mode_reference_chunks VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('ref-1', 1, 'Beta', buf([0,1,0]), 'legacy-space:3', 2, 2, 2, 'Body', 'Beta', 'text', 4, '{"custom":"b"}');
  db.prepare(`INSERT INTO mode_reference_chunks_fts VALUES (?, ?, ?, ?)`).run('1', 'ref-1', 'guide.pdf', 'Alpha');
  db.prepare(`INSERT INTO mode_reference_chunks_fts VALUES (?, ?, ?, ?)`).run('2', 'ref-1', 'guide.pdf', 'Beta');
}

function seedPersonal(db) {
  db.prepare(`INSERT INTO personal_files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('p-1', 'resume.pdf', '/personal/resume.pdf', 'application/pdf', 100, 'hash-p', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', 'resume', 2, 2);
  db.prepare(`INSERT INTO personal_file_chunks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('pc-1', 'p-1', 0, 'Alpha personal', 0, 14, 1, 1, 'Intro', 'Alpha', 'text', '{"custom":"a"}', buf([1,0,0]), 'local', 3, 'local:test-model:3');
  db.prepare(`INSERT INTO personal_file_chunks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('pc-2', 'p-1', 1, 'Beta personal', 15, 28, 2, 2, 'Body', 'Beta', 'text', '{"custom":"b"}', buf([0,1,0]), 'local', 3, 'local:test-model:3');
  db.prepare(`INSERT INTO personal_file_chunks_fts VALUES (?, ?, ?, ?)`).run('pc-1', 'p-1', 'resume.pdf', 'Alpha personal');
  db.prepare(`INSERT INTO personal_file_chunks_fts VALUES (?, ?, ?, ?)`).run('pc-2', 'p-1', 'resume.pdf', 'Beta personal');
}

function seedMeeting(db) {
  db.prepare(`INSERT INTO meetings VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('m-1', 'Meeting One', 1000, 2000, '{"summary":"domain"}', '2026-09-01T00:00:00Z', 'calendar', 1);
  db.prepare(`INSERT INTO transcripts (meeting_id, speaker, content, timestamp_ms) VALUES (?, ?, ?, ?), (?, ?, ?, ?)`).run('m-1', 'Alice', 'Alpha', 100, 'm-1', 'Bob', 'Beta', 200);
  db.prepare(`INSERT INTO ai_interactions (meeting_id, type, timestamp, user_query, ai_response, metadata_json) VALUES (?, ?, ?, ?, ?, ?)`).run('m-1', 'question', 300, 'Q', 'A', '{}');
  db.prepare(`INSERT INTO chunk_summaries (meeting_id, summary_text) VALUES (?, ?)`).run('m-1', 'Separate summary');
  db.prepare(`INSERT INTO chunks VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?)`).run('m-1', 0, 'Alice', 100, 150, 'Alpha', 2, buf([1,0,0]));
  db.prepare(`INSERT INTO chunks VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?)`).run('m-1', 1, 'Bob', 200, 250, 'Beta', 2, buf([0,1,0]));
  db.prepare(`INSERT INTO chunks_fts VALUES (?, ?, ?, ?)`).run('1', 'm-1', 'Alice', 'Alpha');
  db.prepare(`INSERT INTO chunks_fts VALUES (?, ?, ?, ?)`).run('2', 'm-1', 'Bob', 'Beta');
}

test('Phase 4 verifier passes Mode, Personal, and Meeting semantic parity', async () => {
  const db = makeDb();
  seedMode(db); seedPersonal(db); seedMeeting(db);
  const modeHash = createHash('sha256').update('Alpha\nBeta', 'utf8').digest('hex');
  const mode = await indexCanonical(db, { sourceType: 'mode', sourceId: 'ref-1', scopeId: 'mode-1', name: 'guide.pdf', contentHash: modeHash }, [
    { chunkIndex: 0, text: 'Alpha', pageStart: 1, pageEnd: 1, section: 'Intro', heading: 'Alpha', contentType: 'text', tableIndex: null, sourceLocator: 'legacy-mode:ref-1:chunk:0', metadata: { custom: 'a', legacyChunkId: '1', legacyFileId: 'ref-1' } },
    { chunkIndex: 1, text: 'Beta', pageStart: 2, pageEnd: 2, section: 'Body', heading: 'Beta', contentType: 'text', tableIndex: 4, sourceLocator: 'legacy-mode:ref-1:chunk:1', metadata: { custom: 'b', legacyChunkId: '2', legacyFileId: 'ref-1' } },
  ], (t) => t === 'Alpha' ? [1,0,0] : [0,1,0]);

  const personal = await indexCanonical(db, { sourceType: 'personal', sourceId: 'p-1', name: 'resume.pdf', path: '/personal/resume.pdf', mimeType: 'application/pdf', fileType: 'resume', sizeBytes: 100, contentHash: 'hash-p', metadata: { pageCount: 2, extractedPageCount: 2 } }, [
    { chunkIndex: 0, text: 'Alpha personal', pageStart: 1, pageEnd: 1, section: 'Intro', heading: 'Alpha', contentType: 'text', startChar: 0, endChar: 14, sourceLocator: '0', metadata: { custom: 'a', contentType: 'text', legacyChunkId: 'pc-1' } },
    { chunkIndex: 1, text: 'Beta personal', pageStart: 2, pageEnd: 2, section: 'Body', heading: 'Beta', contentType: 'text', startChar: 15, endChar: 28, sourceLocator: '1', metadata: { custom: 'b', contentType: 'text', legacyChunkId: 'pc-2' } },
  ], (t) => t.startsWith('Alpha') ? [1,0,0] : [0,1,0]);
  void personal;

  await indexCanonical(db, { sourceType: 'meeting', sourceId: 'm-1', name: 'Meeting One', contentHash: 'meeting-hash' }, [
    { chunkIndex: 0, text: 'Alpha', speaker: 'Alice', timestampStart: 100, timestampEnd: 150, tokenCount: 2, contentType: 'meeting-transcript-chunk', sourceLocator: 'legacy-meeting:m-1:chunk:1', metadata: { meetingId: 'm-1', legacyChunkId: '1', tokenCount: 2 } },
    { chunkIndex: 1, text: 'Beta', speaker: 'Bob', timestampStart: 200, timestampEnd: 250, tokenCount: 2, contentType: 'meeting-transcript-chunk', sourceLocator: 'legacy-meeting:m-1:chunk:2', metadata: { meetingId: 'm-1', legacyChunkId: '2', tokenCount: 2 } },
  ], (t) => t === 'Alpha' ? [1,0,0] : [0,1,0]);

  const verifier = new CanonicalRagParityVerifier(db);
  const p = verifier.verifyPersonalFile('p-1');
  const m = verifier.verifyMeeting('m-1');
  assert.equal(p.status, 'PASS');
  assert.equal(m.status, 'PASS');
  assert.ok(m.discrepancies.some((d) => d.intentional && d.field === 'chunk_summaries'));
  db.close();
});

test('Phase 4 verifier detects a changed canonical chunk', async () => {
  const db = makeDb();
  seedPersonal(db);
  const indexed = await indexCanonical(db, { sourceType: 'personal', sourceId: 'p-1', name: 'resume.pdf', path: '/personal/resume.pdf', mimeType: 'application/pdf', fileType: 'resume', sizeBytes: 100, contentHash: 'hash-p', metadata: { pageCount: 2, extractedPageCount: 2 } }, [
    { chunkIndex: 0, text: 'Changed', pageStart: 1, pageEnd: 1, section: 'Intro', heading: 'Alpha', contentType: 'text', startChar: 0, endChar: 14, sourceLocator: '0', metadata: { custom: 'a', legacyChunkId: 'pc-1' } },
    { chunkIndex: 1, text: 'Beta personal', pageStart: 2, pageEnd: 2, section: 'Body', heading: 'Beta', contentType: 'text', startChar: 15, endChar: 28, sourceLocator: '1', metadata: { custom: 'b', legacyChunkId: 'pc-2' } },
  ], (t) => t === 'Changed' ? [1,0,0] : [0,1,0]);
  void indexed;
  const verifier = new CanonicalRagParityVerifier(db);
  const result = verifier.verifyPersonalFile('p-1');
  assert.equal(result.status, 'FAIL');
  assert.ok(result.discrepancies.some((d) => d.field === 'text' && d.severity === 'error'));
  db.close();
});

test('Phase 4 verifier classifies live meetings as intentionally excluded', () => {
  const db = makeDb();
  db.prepare(`INSERT INTO meetings (id, title, is_processed) VALUES (?, ?, ?)`).run('live-meeting-current', 'Live', 1);
  const verifier = new CanonicalRagParityVerifier(db);
  const result = verifier.verifyMeeting('live-meeting-current');
  assert.equal(result.status, 'PASS');
  assert.ok(result.discrepancies.some((d) => d.intentional));
  db.close();
});
