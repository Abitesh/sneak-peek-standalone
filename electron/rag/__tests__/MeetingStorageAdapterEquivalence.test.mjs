// electron/rag/__tests__/MeetingStorageAdapterEquivalence.test.mjs
//
// Change 25 — Slice 3B.5
// Focused equivalence/proof coverage for MeetingStorageAdapter's remaining
// storage projections, persistence translations, and deletion semantics. This test deliberately avoids
// production DatabaseManager/VectorStore implementations so it can exercise
// the real adapter against a deterministic in-memory SQLite database without
// changing application state or requiring the full Electron application graph.
//
// Run with the repository's Electron test runner:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test electron/rag/__tests__/MeetingStorageAdapterEquivalence.test.mjs

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const adapterSource = path.join(repoRoot, 'electron/rag/storage/MeetingStorageAdapter.ts');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-meeting-storage-'));
const bundlePath = path.join(tmpDir, 'MeetingStorageAdapter.test.bundle.mjs');

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

let MeetingStorageAdapter;

before(async () => {
  const dbManagerStub = `
    export class DatabaseManager {
      static getInstance() { return new DatabaseManager(); }
      getExistingVecDims() { return [2]; }
    }
  `;

  const vectorStoreStub = `
    export class VectorStore {
      saveSummary() {}
      clearEmbeddingsForMeeting() {}
      storeEmbedding() {}
      storeSummaryEmbedding() {}
    }
  `;

  await build({
    entryPoints: [adapterSource],
    outfile: bundlePath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    plugins: [{
      name: 'meeting-storage-test-stubs',
      setup(buildApi) {
        buildApi.onResolve({ filter: /(?:^|\/)DatabaseManager$/ }, () => ({
          path: 'virtual:database-manager-stub',
          namespace: 'meeting-storage-test',
        }));
        buildApi.onLoad({ filter: /.*/, namespace: 'meeting-storage-test' }, (args) => {
          if (args.path === 'virtual:database-manager-stub') {
            return { contents: dbManagerStub, loader: 'js' };
          }
          return null;
        });
        buildApi.onResolve({ filter: /(?:^|\/)VectorStore$/ }, () => ({
          path: 'virtual:vector-store-stub',
          namespace: 'meeting-storage-test',
        }));
        buildApi.onLoad({ filter: /.*/, namespace: 'meeting-storage-test' }, (args) => {
          if (args.path === 'virtual:vector-store-stub') {
            return { contents: vectorStoreStub, loader: 'js' };
          }
          return null;
        });
      },
    }],
  });

  ({ MeetingStorageAdapter } = await import(pathToFileURL(bundlePath).href));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      start_time INTEGER,
      duration_ms INTEGER,
      summary_json TEXT,
      created_at TEXT,
      calendar_event_id TEXT,
      source TEXT,
      is_processed INTEGER,
      summary_status TEXT,
      user_titled INTEGER,
      embedding_provider TEXT,
      embedding_dimensions INTEGER,
      embedding_space TEXT
    );

    CREATE TABLE transcripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL,
      speaker TEXT,
      content TEXT,
      timestamp_ms INTEGER
    );

    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      speaker TEXT,
      start_timestamp_ms INTEGER,
      end_timestamp_ms INTEGER,
      cleaned_text TEXT,
      token_count INTEGER
    );

    CREATE TABLE chunk_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL,
      summary_text TEXT,
      created_at TEXT
    );

    CREATE TABLE embedding_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL
    );

    -- Regular SQLite tables stand in for the existing sqlite-vec tables.
    -- Foreign keys intentionally force vector-before-parent deletion order.
    CREATE TABLE vec_chunks_2 (
      chunk_id INTEGER PRIMARY KEY,
      FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE RESTRICT
    );

    CREATE TABLE vec_summaries_2 (
      summary_id INTEGER PRIMARY KEY,
      FOREIGN KEY (summary_id) REFERENCES chunk_summaries(id) ON DELETE RESTRICT
    );
  `);
  return db;
}

function seedMeeting(db, meetingId = 'meeting-1') {
  db.prepare(`
    INSERT INTO meetings (
      id, title, start_time, duration_ms, summary_json, created_at,
      calendar_event_id, source, is_processed, summary_status, user_titled,
      embedding_provider, embedding_dimensions, embedding_space
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    meetingId,
    'Storage Boundary Test',
    1700000000000,
    540000,
    '{"legacySummary":"short"}',
    '2026-09-12T10:00:00.000Z',
    'calendar-123',
    'calendar',
    1,
    'completed',
    1,
    'local',
    384,
    'local:xenova/all-minilm-l6-v2:384',
  );
}

function seedIndexedRows(db, meetingId = 'meeting-1') {
  seedMeeting(db, meetingId);

  const transcriptId = db.prepare(`
    INSERT INTO transcripts (meeting_id, speaker, content, timestamp_ms)
    VALUES (?, ?, ?, ?)
  `).run(meetingId, 'A', 'transcript', 100).lastInsertRowid;

  const chunkId = db.prepare(`
    INSERT INTO chunks (
      meeting_id, chunk_index, speaker, start_timestamp_ms,
      end_timestamp_ms, cleaned_text, token_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(meetingId, 0, 'A', 0, 100, 'indexed chunk', 3).lastInsertRowid;

  const summaryId = db.prepare(`
    INSERT INTO chunk_summaries (meeting_id, summary_text, created_at)
    VALUES (?, ?, ?)
  `).run(meetingId, 'indexed summary', '2026-09-12T10:05:00.000Z').lastInsertRowid;

  db.prepare('INSERT INTO embedding_queue (meeting_id) VALUES (?)').run(meetingId);
  db.prepare('INSERT INTO vec_chunks_2 (chunk_id) VALUES (?)').run(chunkId);
  db.prepare('INSERT INTO vec_summaries_2 (summary_id) VALUES (?)').run(summaryId);

  return {
    transcriptId: Number(transcriptId),
    chunkId: Number(chunkId),
    summaryId: Number(summaryId),
  };
}

function makeAdapter(db, vectorStore = null) {
  const fakeVectorStore = vectorStore ?? {
    saveSummaryCalls: [],
    clearCalls: [],
    chunkEmbeddingCalls: [],
    summaryEmbeddingCalls: [],
    saveSummary(meetingId, text) {
      this.saveSummaryCalls.push([meetingId, text]);
    },
    clearEmbeddingsForMeeting(meetingId) {
      this.clearCalls.push(meetingId);
    },
    storeEmbedding(id, embedding) {
      this.chunkEmbeddingCalls.push([id, embedding]);
    },
    storeSummaryEmbedding(meetingId, embedding) {
      this.summaryEmbeddingCalls.push([meetingId, embedding]);
    },
  };
  return { adapter: new MeetingStorageAdapter(db, fakeVectorStore), vectorStore: fakeVectorStore };
}

describe('MeetingStorageAdapter storage projections', () => {
  test('readMeeting preserves the storage-facing meeting projection', () => {
    const db = makeDb();
    try {
      seedMeeting(db);
      const { adapter } = makeAdapter(db);
      assert.deepEqual(adapter.readMeeting('meeting-1'), {
        id: 'meeting-1',
        title: 'Storage Boundary Test',
        startTime: 1700000000000,
        durationMs: 540000,
        summaryJson: '{"legacySummary":"short"}',
        createdAt: '2026-09-12T10:00:00.000Z',
        calendarEventId: 'calendar-123',
        source: 'calendar',
        isProcessed: true,
        summaryStatus: 'completed',
        userTitled: true,
        embeddingProvider: 'local',
        embeddingDimensions: 384,
        embeddingSpace: 'local:xenova/all-minilm-l6-v2:384',
      });
      assert.equal(adapter.readMeeting('missing'), null);
    } finally {
      db.close();
    }
  });

  test('readTranscript preserves timestamp ordering and transcript fields', () => {
    const db = makeDb();
    try {
      seedMeeting(db);
      const insert = db.prepare('INSERT INTO transcripts (meeting_id, speaker, content, timestamp_ms) VALUES (?, ?, ?, ?)');
      insert.run('meeting-1', 'B', 'second', 200);
      insert.run('meeting-1', 'A', 'first', 100);
      insert.run('meeting-1', 'C', 'same-time-later-id', 200);

      const { adapter } = makeAdapter(db);
      const rows = adapter.readTranscript('meeting-1');
      assert.equal(rows.length, 3);
      assert.deepEqual(rows.map((row) => [row.speaker, row.content, row.timestampMs]), [
        ['A', 'first', 100],
        ['B', 'second', 200],
        ['C', 'same-time-later-id', 200],
      ]);
      assert.ok(rows.every((row) => row.meetingId === 'meeting-1'));
      assert.ok(rows.every((row) => Number.isInteger(row.id)));
    } finally {
      db.close();
    }
  });

  test('readChunks preserves canonical fields and physical IDs', () => {
    const db = makeDb();
    try {
      seedMeeting(db);
      const insert = db.prepare(`
        INSERT INTO chunks (
          meeting_id, chunk_index, speaker, start_timestamp_ms,
          end_timestamp_ms, cleaned_text, token_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const first = insert.run('meeting-1', 1, 'A', 100, 180, 'second chunk', 12);
      const second = insert.run('meeting-1', 0, 'B', 0, 99, 'first chunk', 9);

      const { adapter } = makeAdapter(db);
      const rows = adapter.readChunks('meeting-1');
      assert.deepEqual(rows, [
        {
          id: String(second.lastInsertRowid),
          documentId: 'meeting-1',
          text: 'first chunk',
          chunkIndex: 0,
          speaker: 'B',
          timestampStart: 0,
          timestampEnd: 99,
          metadata: { tokenCount: 9 },
        },
        {
          id: String(first.lastInsertRowid),
          documentId: 'meeting-1',
          text: 'second chunk',
          chunkIndex: 1,
          speaker: 'A',
          timestampStart: 100,
          timestampEnd: 180,
          metadata: { tokenCount: 12 },
        },
      ]);
    } finally {
      db.close();
    }
  });

  test('readSearchableSummary preserves summary identity and text', () => {
    const db = makeDb();
    try {
      seedMeeting(db);
      db.prepare('INSERT INTO chunk_summaries (meeting_id, summary_text, created_at) VALUES (?, ?, ?)')
        .run('meeting-1', 'A searchable summary', '2026-09-12T10:05:00.000Z');

      const { adapter } = makeAdapter(db);
      assert.deepEqual(adapter.readSearchableSummary('meeting-1'), {
        id: 1,
        meetingId: 'meeting-1',
        summaryText: 'A searchable summary',
        createdAt: '2026-09-12T10:05:00.000Z',
      });
      assert.equal(adapter.readSearchableSummary('missing'), null);
    } finally {
      db.close();
    }
  });
});

describe('MeetingStorageAdapter persistence translation', () => {
  test('replaceTranscript is idempotent and replaces only the meeting transcript', () => {
    const db = makeDb();
    try {
      seedMeeting(db);
      seedMeeting(db, 'meeting-2');
      db.prepare('INSERT INTO transcripts (meeting_id, speaker, content, timestamp_ms) VALUES (?, ?, ?, ?)')
        .run('meeting-1', 'Old', 'old text', 1);
      db.prepare('INSERT INTO transcripts (meeting_id, speaker, content, timestamp_ms) VALUES (?, ?, ?, ?)')
        .run('meeting-2', 'Other', 'must remain', 1);

      const { adapter } = makeAdapter(db);
      adapter.replaceTranscript('meeting-1', [
        { meetingId: 'meeting-1', speaker: 'A', content: 'new one', timestampMs: 10 },
        { meetingId: 'meeting-1', speaker: 'B', content: 'new two', timestampMs: 20 },
      ]);

      assert.deepEqual(adapter.readTranscript('meeting-1').map((row) => row.content), ['new one', 'new two']);
      assert.deepEqual(adapter.readTranscript('meeting-2').map((row) => row.content), ['must remain']);
    } finally {
      db.close();
    }
  });

  test('replaceChunks returns explicit canonical-to-physical mappings', () => {
    const db = makeDb();
    try {
      seedMeeting(db);
      const { adapter } = makeAdapter(db);
      const mappings = adapter.replaceChunks('meeting-1', [
        { id: 'canonical-a', documentId: 'meeting-1', text: 'alpha', chunkIndex: 0, metadata: { tokenCount: 3 } },
        { id: 'canonical-b', documentId: 'meeting-1', text: 'beta', chunkIndex: 1, metadata: { tokenCount: 4 } },
      ]);

      assert.deepEqual(mappings.map((mapping) => mapping.canonicalId), ['canonical-a', 'canonical-b']);
      assert.equal(mappings.length, 2);
      assert.ok(mappings.every((mapping) => /^\d+$/.test(mapping.physicalId)));
      assert.deepEqual(adapter.readChunks('meeting-1').map((chunk) => chunk.text), ['alpha', 'beta']);
      assert.deepEqual(
        mappings.map((mapping) => db.prepare('SELECT id FROM chunks WHERE id = ?').get(Number(mapping.physicalId))?.id),
        mappings.map((mapping) => Number(mapping.physicalId)),
      );
    } finally {
      db.close();
    }
  });

  test('storeChunkEmbedding uses the physical SQLite chunk ID and preserves meeting embedding metadata', () => {
    const db = makeDb();
    try {
      seedMeeting(db);
      const { adapter, vectorStore } = makeAdapter(db);
      const id = db.prepare(`
        INSERT INTO chunks (meeting_id, chunk_index, speaker, start_timestamp_ms, end_timestamp_ms, cleaned_text, token_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('meeting-1', 0, 'A', 0, 100, 'embedded', 2).lastInsertRowid;

      adapter.storeChunkEmbedding(String(id), {
        target: 'chunk',
        embedding: {
          embedding: [0.1, 0.2],
          space: 'test:space:2',
          provider: 'test-provider',
          dimensions: 2,
        },
      });

      assert.deepEqual(vectorStore.chunkEmbeddingCalls, [[Number(id), [0.1, 0.2]]]);
      assert.deepEqual(db.prepare('SELECT embedding_space, embedding_provider, embedding_dimensions FROM meetings WHERE id = ?').get('meeting-1'), {
        embedding_space: 'test:space:2',
        embedding_provider: 'test-provider',
        embedding_dimensions: 2,
      });
    } finally {
      db.close();
    }
  });

  test('writeSearchableSummary and clearEmbeddings delegate without owning retrieval', () => {
    const db = makeDb();
    try {
      seedMeeting(db);
      const { adapter, vectorStore } = makeAdapter(db);
      adapter.writeSearchableSummary('meeting-1', 'summary');
      adapter.clearEmbeddings('meeting-1');
      assert.deepEqual(vectorStore.saveSummaryCalls, [['meeting-1', 'summary']]);
      assert.deepEqual(vectorStore.clearCalls, ['meeting-1']);
    } finally {
      db.close();
    }
  });
});


describe('MeetingStorageAdapter embedding and deletion proof', () => {
  test('storeSummaryEmbedding delegates to VectorStore and preserves meeting embedding metadata', () => {
    const db = makeDb();
    try {
      seedMeeting(db);
      const { adapter, vectorStore } = makeAdapter(db);

      adapter.storeSummaryEmbedding('meeting-1', {
        target: 'summary',
        embedding: {
          embedding: [0.3, 0.4],
          space: 'test:summary-space:2',
          provider: 'summary-provider',
          dimensions: 2,
        },
      });

      assert.deepEqual(vectorStore.summaryEmbeddingCalls, [
        ['meeting-1', [0.3, 0.4]],
      ]);
      assert.deepEqual(
        db.prepare(`
          SELECT embedding_space, embedding_provider, embedding_dimensions
          FROM meetings
          WHERE id = ?
        `).get('meeting-1'),
        {
          embedding_space: 'test:summary-space:2',
          embedding_provider: 'summary-provider',
          embedding_dimensions: 2,
        },
      );
    } finally {
      db.close();
    }
  });

  test('deleteMeetingIndex removes vectors before parent rows and preserves the meeting aggregate', () => {
    const db = makeDb();
    try {
      const ids = seedIndexedRows(db);

      const { adapter } = makeAdapter(db);
      adapter.deleteMeetingIndex('meeting-1');

      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM vec_chunks_2 WHERE chunk_id = ?')
          .get(ids.chunkId).count,
        0,
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM vec_summaries_2 WHERE summary_id = ?')
          .get(ids.summaryId).count,
        0,
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM chunks WHERE meeting_id = ?')
          .get('meeting-1').count,
        0,
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM chunk_summaries WHERE meeting_id = ?')
          .get('meeting-1').count,
        0,
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM embedding_queue WHERE meeting_id = ?')
          .get('meeting-1').count,
        0,
      );

      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM meetings WHERE id = ?')
          .get('meeting-1').count,
        1,
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM transcripts WHERE meeting_id = ?')
          .get('meeting-1').count,
        1,
      );
      assert.deepEqual(
        db.prepare(`
          SELECT embedding_provider, embedding_dimensions, embedding_space
          FROM meetings
          WHERE id = ?
        `).get('meeting-1'),
        {
          embedding_provider: null,
          embedding_dimensions: null,
          embedding_space: null,
        },
      );
    } finally {
      db.close();
    }
  });

  test('deleteMeeting removes owned aggregate rows, queue rows, and vectors', () => {
    const db = makeDb();
    try {
      const ids = seedIndexedRows(db);

      const { adapter } = makeAdapter(db);
      assert.equal(adapter.deleteMeeting('meeting-1'), true);

      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM vec_chunks_2 WHERE chunk_id = ?')
          .get(ids.chunkId).count,
        0,
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM vec_summaries_2 WHERE summary_id = ?')
          .get(ids.summaryId).count,
        0,
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM chunks WHERE meeting_id = ?')
          .get('meeting-1').count,
        0,
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM chunk_summaries WHERE meeting_id = ?')
          .get('meeting-1').count,
        0,
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM transcripts WHERE meeting_id = ?')
          .get('meeting-1').count,
        0,
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM embedding_queue WHERE meeting_id = ?')
          .get('meeting-1').count,
        0,
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM meetings WHERE id = ?')
          .get('meeting-1').count,
        0,
      );
      assert.equal(adapter.deleteMeeting('meeting-1'), false);
    } finally {
      db.close();
    }
  });

  test('deleteMeetingIndex rolls back all physical cleanup when summary-vector deletion fails', () => {
    const db = makeDb();
    try {
      const ids = seedIndexedRows(db);

      db.exec(`
        CREATE TRIGGER fail_summary_vector_delete
        BEFORE DELETE ON vec_summaries_2
        BEGIN
          SELECT RAISE(ABORT, 'intentional summary vector failure');
        END;
      `);

      const { adapter } = makeAdapter(db);
      assert.throws(
        () => adapter.deleteMeetingIndex('meeting-1'),
        /intentional summary vector failure/,
      );

      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM vec_chunks_2 WHERE chunk_id = ?')
          .get(ids.chunkId).count,
        1,
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM vec_summaries_2 WHERE summary_id = ?')
          .get(ids.summaryId).count,
        1,
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM chunks WHERE meeting_id = ?')
          .get('meeting-1').count,
        1,
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM chunk_summaries WHERE meeting_id = ?')
          .get('meeting-1').count,
        1,
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM embedding_queue WHERE meeting_id = ?')
          .get('meeting-1').count,
        1,
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM meetings WHERE id = ?')
          .get('meeting-1').count,
        1,
      );
      assert.deepEqual(
        db.prepare(`
          SELECT embedding_provider, embedding_dimensions, embedding_space
          FROM meetings
          WHERE id = ?
        `).get('meeting-1'),
        {
          embedding_provider: 'local',
          embedding_dimensions: 384,
          embedding_space: 'local:xenova/all-minilm-l6-v2:384',
        },
      );
    } finally {
      db.close();
    }
  });
});
