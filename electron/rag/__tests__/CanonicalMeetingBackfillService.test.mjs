import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { installCanonicalRagSchema } from '../../../dist-electron/electron/rag/canonical/CanonicalRagSchema.js';
import { CanonicalRagStorage } from '../../../dist-electron/electron/rag/canonical/CanonicalRagStorage.js';
import { CanonicalRagIndexer } from '../../../dist-electron/electron/rag/canonical/CanonicalRagIndexer.js';
import { CanonicalEmbeddingService } from '../../../dist-electron/electron/rag/canonical/CanonicalEmbeddingService.js';
import { CanonicalMeetingBackfillService } from '../../../dist-electron/electron/rag/canonical/CanonicalMeetingBackfillService.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  let ext = sqliteVec.getLoadablePath();
  ext = ext.replace('app.asar', 'app.asar.unpacked').replace(/\.(dylib|so|dll)$/, '');
  db.loadExtension(ext);
  db.exec(`
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY,
      title TEXT,
      start_time INTEGER,
      duration_ms INTEGER,
      summary_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      calendar_event_id TEXT,
      source TEXT,
      is_processed INTEGER DEFAULT 1,
      summary_status TEXT DEFAULT 'completed',
      user_titled INTEGER DEFAULT 0,
      embedding_provider TEXT,
      embedding_dimensions INTEGER,
      embedding_space TEXT
    );
    CREATE TABLE transcripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT,
      speaker TEXT,
      content TEXT,
      timestamp_ms INTEGER,
      FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );
    CREATE TABLE ai_interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT,
      type TEXT,
      timestamp INTEGER,
      user_query TEXT,
      ai_response TEXT,
      metadata_json TEXT,
      FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      speaker TEXT,
      start_timestamp_ms INTEGER,
      end_timestamp_ms INTEGER,
      cleaned_text TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      embedding BLOB,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );
    CREATE TABLE chunk_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL UNIQUE,
      summary_text TEXT NOT NULL,
      embedding BLOB,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );
    CREATE TABLE embedding_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL,
      chunk_id INTEGER,
      status TEXT DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0,
      error_message TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      processed_at TEXT
    );
  `);
  installCanonicalRagSchema(db);
  return db;
}

function vectorFor(text) {
  return text.includes('first') ? [1, 0, 0] : [0, 1, 0];
}

function seedMeeting(db, id, processed = 1) {
  db.prepare(`INSERT INTO meetings
    (id, title, start_time, duration_ms, summary_json, created_at, source, is_processed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, `Meeting ${id}`, 1000, 2000, '{"summary":"domain data"}',
    '2026-09-01T00:00:00.000Z', 'calendar', processed,
  );
  db.prepare(`INSERT INTO transcripts (meeting_id, speaker, content, timestamp_ms)
    VALUES (?, ?, ?, ?), (?, ?, ?, ?)`).run(
    id, 'Alice', 'First transcript source', 100,
    id, 'Bob', 'Second transcript source', 200,
  );
  db.prepare(`INSERT INTO ai_interactions (meeting_id, type, timestamp, user_query, ai_response, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, 'question', 300, 'Q', 'A', '{}');
  db.prepare(`INSERT INTO chunk_summaries (meeting_id, summary_text) VALUES (?, ?)`)
    .run(id, 'Separate meeting summary');
  db.prepare(`INSERT INTO chunks
    (meeting_id, chunk_index, speaker, start_timestamp_ms, end_timestamp_ms, cleaned_text, token_count)
    VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`).run(
    id, 0, 'Alice', 100, 150, 'first transcript source', 3,
    id, 1, 'Bob', 200, 250, 'second transcript source', 3,
  );
}

function makeFixture(db) {
  const storage = new CanonicalRagStorage(db);
  const meetingStorage = {
    readMeeting(id) {
      const row = db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
      if (!row) return null;
      return {
        id: row.id,
        title: row.title,
        startTime: row.start_time,
        durationMs: row.duration_ms,
        summaryJson: row.summary_json,
        createdAt: row.created_at,
        source: row.source,
      };
    },
    readTranscript() { return []; },
    readChunks(id) {
      return db.prepare(`SELECT id, meeting_id, chunk_index, speaker, start_timestamp_ms, end_timestamp_ms, cleaned_text, token_count
        FROM chunks WHERE meeting_id = ? ORDER BY chunk_index, id`).all(id).map((row) => ({
        id: String(row.id),
        documentId: String(row.meeting_id),
        text: row.cleaned_text,
        chunkIndex: row.chunk_index,
        speaker: row.speaker,
        timestampStart: row.start_timestamp_ms,
        timestampEnd: row.end_timestamp_ms,
        metadata: { tokenCount: row.token_count },
      }));
    },
    readSearchableSummary(id) {
      const row = db.prepare('SELECT * FROM chunk_summaries WHERE meeting_id = ?').get(id);
      return row ? { id: row.id, meetingId: id, summaryText: row.summary_text, createdAt: row.created_at } : null;
    },
  };
  const provider = {
    provider: 'local',
    model: 'test-meeting-model',
    dimensions: 3,
    version: 'test-v1',
    async embedBatch(texts) { return texts.map(vectorFor); },
  };
  const embeddingService = new CanonicalEmbeddingService(storage, provider);
  const indexerFactory = (s) => new CanonicalRagIndexer(s, embeddingService);
  return { storage, meetingStorage, indexerFactory };
}

test('meeting backfill projects persisted transcript chunks into canonical RAG and reaches READY', async () => {
  const db = makeDb();
  seedMeeting(db, 'meeting-1');
  const before = {
    meeting: db.prepare('SELECT * FROM meetings WHERE id = ?').get('meeting-1'),
    transcript: db.prepare('SELECT * FROM transcripts WHERE meeting_id = ? ORDER BY id').all('meeting-1'),
    interactions: db.prepare('SELECT * FROM ai_interactions WHERE meeting_id = ?').all('meeting-1'),
    summary: db.prepare('SELECT * FROM chunk_summaries WHERE meeting_id = ?').get('meeting-1'),
    chunks: db.prepare('SELECT * FROM chunks WHERE meeting_id = ? ORDER BY id').all('meeting-1'),
  };
  const { storage, meetingStorage, indexerFactory } = makeFixture(db);
  const service = new CanonicalMeetingBackfillService(db, meetingStorage, storage, indexerFactory);
  const result = await service.backfillMeeting('meeting-1');

  assert.equal(result.complete, true);
  assert.equal(result.activated, true);
  assert.equal(result.chunkCount, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_documents WHERE source_type = ? AND source_id = ?').get('meeting', 'meeting-1').n, 1);
  const chunks = db.prepare('SELECT * FROM rag_chunks WHERE revision_id = ? ORDER BY chunk_index').all(result.revisionId);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].speaker, 'Alice');
  assert.equal(chunks[0].timestamp_start, 100);
  assert.equal(JSON.parse(chunks[0].metadata_json).legacyChunkId, '1');
  assert.equal(JSON.parse(chunks[0].metadata_json).legacyMeetingId, 'meeting-1');
  assert.equal(db.prepare('SELECT status FROM rag_canonical_index_status WHERE document_id = ? AND revision_id = ?').get(result.documentId, result.revisionId).status, 'READY');

  assert.deepEqual(db.prepare('SELECT * FROM meetings WHERE id = ?').get('meeting-1'), before.meeting);
  assert.deepEqual(db.prepare('SELECT * FROM transcripts WHERE meeting_id = ? ORDER BY id').all('meeting-1'), before.transcript);
  assert.deepEqual(db.prepare('SELECT * FROM ai_interactions WHERE meeting_id = ?').all('meeting-1'), before.interactions);
  assert.deepEqual(db.prepare('SELECT * FROM chunk_summaries WHERE meeting_id = ?').get('meeting-1'), before.summary);
  assert.deepEqual(db.prepare('SELECT * FROM chunks WHERE meeting_id = ? ORDER BY id').all('meeting-1'), before.chunks);
  db.close();
});

test('meeting backfill is idempotent for unchanged searchable chunks', async () => {
  const db = makeDb();
  seedMeeting(db, 'meeting-idempotent');
  const { storage, meetingStorage, indexerFactory } = makeFixture(db);
  const service = new CanonicalMeetingBackfillService(db, meetingStorage, storage, indexerFactory);
  const first = await service.backfillMeeting('meeting-idempotent');
  const counts = {
    documents: db.prepare('SELECT COUNT(*) AS n FROM rag_documents').get().n,
    revisions: db.prepare('SELECT COUNT(*) AS n FROM rag_document_revisions').get().n,
    chunks: db.prepare('SELECT COUNT(*) AS n FROM rag_chunks').get().n,
    embeddings: db.prepare('SELECT COUNT(*) AS n FROM rag_embeddings').get().n,
  };
  const second = await service.backfillMeeting('meeting-idempotent');
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

test('meeting backfill creates a new revision when the searchable chunk corpus changes', async () => {
  const db = makeDb();
  seedMeeting(db, 'meeting-revision');
  const { storage, meetingStorage, indexerFactory } = makeFixture(db);
  const service = new CanonicalMeetingBackfillService(db, meetingStorage, storage, indexerFactory);
  const first = await service.backfillMeeting('meeting-revision');
  db.prepare('UPDATE chunks SET cleaned_text = ? WHERE meeting_id = ? AND chunk_index = 1')
    .run('changed transcript source', 'meeting-revision');
  const second = await service.backfillMeeting('meeting-revision');
  assert.notEqual(second.revisionId, first.revisionId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_document_revisions WHERE document_id = ?').get(first.documentId).n, 2);
  assert.equal(db.prepare('SELECT current_revision_id FROM rag_documents WHERE id = ?').get(first.documentId).current_revision_id, second.revisionId);
  db.close();
});

test('meeting backfill excludes live/transient meetings and isolates failures', async () => {
  const db = makeDb();
  seedMeeting(db, 'meeting-good');
  seedMeeting(db, 'live-meeting-current');
  seedMeeting(db, 'meeting-unprocessed', 0);
  db.prepare('DELETE FROM chunks WHERE meeting_id = ?').run('live-meeting-current');
  db.prepare('DELETE FROM chunks WHERE meeting_id = ?').run('meeting-unprocessed');
  const { storage, meetingStorage, indexerFactory } = makeFixture(db);
  const service = new CanonicalMeetingBackfillService(db, meetingStorage, storage, indexerFactory);
  assert.deepEqual(service.listEligibleMeetingIds(), ['meeting-good']);
  const summary = await service.backfillAll(['meeting-good', 'meeting-missing', 'live-meeting-current']);
  assert.equal(summary.attempted, 3);
  assert.equal(summary.completed, 1);
  assert.equal(summary.failed, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_documents WHERE source_id = ?').get('meeting-good').n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_documents WHERE source_id = ?').get('meeting-missing').n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rag_documents WHERE source_id = ?').get('live-meeting-current').n, 0);
  db.close();
});
