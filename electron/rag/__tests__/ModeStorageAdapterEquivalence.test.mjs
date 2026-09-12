import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function loadAdapter() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mode-storage-adapter-'));
  const outfile = path.join(dir, 'adapter.mjs');
  const dbStub = `
    export class DatabaseManager {
      static active = null;
      static calls = [];
      static getInstance() { return new DatabaseManager(); }
      static configure(db) { DatabaseManager.active = db; DatabaseManager.calls = []; }
      replaceModeReferenceChunks(documentId, chunks, baseMetadata) {
        DatabaseManager.calls.push({ documentId, chunks, baseMetadata });
        const db = DatabaseManager.active;
        const tx = db.transaction(() => {
          db.prepare('DELETE FROM mode_reference_chunks WHERE file_id = ?').run(documentId);
          const insert = db.prepare(\`INSERT INTO mode_reference_chunks
            (file_id, chunk_index, text, page_start, page_end, section, heading, content_type, table_index, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`);
          for (const chunk of chunks) {
            insert.run(documentId, chunk.chunkIndex, chunk.text, chunk.pageStart ?? null, chunk.pageEnd ?? null,
              chunk.section ?? null, chunk.heading ?? null, chunk.contentType ?? 'text', chunk.tableIndex ?? null,
              JSON.stringify(chunk.metadata ?? {}));
          }
        });
        tx();
        return db.prepare('SELECT id FROM mode_reference_chunks WHERE file_id = ? ORDER BY chunk_index').all(documentId).map(r => Number(r.id));
      }
    }
  `;
  const vectorStub = `
    export class VectorStore {}
  `;
  const plugin = {
    name: 'test-stubs',
    setup(buildApi) {
      buildApi.onResolve({ filter: /(?:^|\/)DatabaseManager(?:\.ts)?$/ }, args => ({ path: 'db-stub', namespace: 'stub' }));
      buildApi.onResolve({ filter: /(?:^|\/)VectorStore(?:\.ts)?$/ }, args => ({ path: 'vector-stub', namespace: 'stub' }));
      buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({
        contents: args.path === 'db-stub' ? dbStub : vectorStub,
        loader: 'js',
      }));
    },
  };
  const project = process.cwd();
  await build({
    entryPoints: [path.join(project, 'electron/rag/storage/ModeStorageAdapter.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    plugins: [plugin],
    external: ['better-sqlite3'],
  });
  return { mod: await import(pathToFileURL(outfile).href + `?t=${Date.now()}`), dir };
}

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE mode_reference_files (
      id TEXT PRIMARY KEY, mode_id TEXT, file_name TEXT, content TEXT, created_at TEXT,
      page_count INTEGER, extracted_page_count INTEGER
    );
    CREATE TABLE mode_reference_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, file_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL, page_start INTEGER, page_end INTEGER, section TEXT, heading TEXT,
      content_type TEXT, table_index INTEGER, metadata_json TEXT,
      UNIQUE(file_id, chunk_index), FOREIGN KEY(file_id) REFERENCES mode_reference_files(id) ON DELETE CASCADE
    );
    CREATE VIRTUAL TABLE mode_reference_chunks_fts USING fts5(chunk_id UNINDEXED, file_id UNINDEXED, file_name, text);
    CREATE TRIGGER mode_chunks_ai AFTER INSERT ON mode_reference_chunks BEGIN
      INSERT INTO mode_reference_chunks_fts(rowid, chunk_id, file_id, file_name, text)
      SELECT new.id, new.id, new.file_id, COALESCE((SELECT file_name FROM mode_reference_files WHERE id = new.file_id), ''), new.text;
    END;
    CREATE TRIGGER mode_chunks_ad AFTER DELETE ON mode_reference_chunks BEGIN
      DELETE FROM mode_reference_chunks_fts WHERE rowid = old.id;
    END;
    CREATE TRIGGER mode_chunks_au AFTER UPDATE ON mode_reference_chunks BEGIN
      DELETE FROM mode_reference_chunks_fts WHERE rowid = old.id;
      INSERT INTO mode_reference_chunks_fts(rowid, chunk_id, file_id, file_name, text)
      SELECT new.id, new.id, new.file_id, COALESCE((SELECT file_name FROM mode_reference_files WHERE id = new.file_id), ''), new.text;
    END;
  `);
  return db;
}

function seed(db) {
  db.prepare('INSERT INTO mode_reference_files VALUES (?, ?, ?, ?, ?, ?, ?)').run('file-a', 'mode-1', 'guide.pdf', 'body', '2026-09-12T10:00:00Z', 4, 4);
  db.prepare('INSERT INTO mode_reference_files VALUES (?, ?, ?, ?, ?, ?, ?)').run('file-b', 'mode-2', 'other.pdf', 'other', '2026-09-12T11:00:00Z', 1, 1);
  const insert = db.prepare(`INSERT INTO mode_reference_chunks
    (file_id, chunk_index, text, page_start, page_end, section, heading, content_type, table_index, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run('file-a', 0, 'alpha topic', 1, 1, 'Intro', 'Alpha', 'text', null, JSON.stringify({ source: 'fixture' }));
  insert.run('file-a', 1, 'beta topic', 2, 3, 'Body', 'Beta', 'table', 2, JSON.stringify({ source: 'fixture' }));
  insert.run('file-b', 0, 'other document', 1, 1, null, null, 'text', null, '{}');
}

let ModeStorageAdapter, DatabaseManager;
const loaded = await loadAdapter();
ModeStorageAdapter = loaded.mod.ModeStorageAdapter;
// The bundled module exposes the stub only internally, so configure it through the adapter test's DB behavior indirectly.
// For mutation tests we provide a tiny interception by importing the adapter and using its constructor; the stub keeps the active DB
// on the module copy, so retrieve the class from the bundled module and configure via the static hook exported for tests.
// Rebuild with an explicit test hook below if needed.

// The adapter's DatabaseManager import is bundled. To keep this file production-neutral, mutation equivalence is exercised by
// replacing the helper through a DB-compatible shim attached to the module's imported constructor is not possible from ESM.
// Therefore the tests below focus on the adapter's read projection, metadata/ID rules, and VectorStore delegation, while a second
// bundle exposes the DatabaseManager stub hook for write/delete coverage.

async function loadAdapterWithHook() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mode-storage-adapter-hook-'));
  const outfile = path.join(dir, 'adapter.mjs');
  const dbStub = `
    export class DatabaseManager {
      static active = null; static calls = [];
      static configure(db) { this.active = db; this.calls = []; }
      static getInstance() { return new DatabaseManager(); }
      replaceModeReferenceChunks(documentId, chunks, baseMetadata) {
        DatabaseManager.calls.push({documentId, chunks, baseMetadata});
        const db = DatabaseManager.active;
        const tx = db.transaction(() => {
          db.prepare('DELETE FROM mode_reference_chunks WHERE file_id = ?').run(documentId);
          const ins = db.prepare(\`INSERT INTO mode_reference_chunks (file_id, chunk_index, text, page_start, page_end, section, heading, content_type, table_index, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`);
          for (const c of chunks) ins.run(documentId, c.chunkIndex, c.text, c.pageStart ?? null, c.pageEnd ?? null, c.section ?? null, c.heading ?? null, c.contentType ?? 'text', c.tableIndex ?? null, JSON.stringify(c.metadata ?? {}));
        }); tx();
        return db.prepare('SELECT id FROM mode_reference_chunks WHERE file_id = ? ORDER BY chunk_index').all(documentId).map(r => Number(r.id));
      }
    }
    globalThis.__CHANGE25_TEST_DB_MANAGER__ = DatabaseManager;
  `;
  const vectorStub = `export class VectorStore {}`;
  const plugin = { name: 'stubs', setup(b) {
    b.onResolve({filter: /(?:^|\/)DatabaseManager(?:\.ts)?$/}, () => ({path:'db', namespace:'s'}));
    b.onResolve({filter: /(?:^|\/)VectorStore(?:\.ts)?$/}, () => ({path:'vec', namespace:'s'}));
    b.onLoad({filter:/.*/, namespace:'s'}, a => ({contents: a.path === 'db' ? dbStub : vectorStub, loader:'js'}));
  }};
  await build({entryPoints:[path.join(process.cwd(),'electron/rag/storage/ModeStorageAdapter.ts')], outfile, bundle:true, format:'esm', platform:'node', plugins:[plugin], external:['better-sqlite3']});
  return import(pathToFileURL(outfile).href + `?t=${Date.now()}`);
}

const hooked = await loadAdapterWithHook();
const TestDbManager = globalThis.__CHANGE25_TEST_DB_MANAGER__;
assert.ok(TestDbManager, 'DatabaseManager test hook was not initialized');
ModeStorageAdapter = hooked.ModeStorageAdapter;

function vectorSpy() {
  return {
    cleared: [], stored: [],
    deleteModeReferenceEmbeddingsForFile(id) { this.cleared.push(id); },
    storeModeReferenceEmbedding(...args) { this.stored.push(args); },
  };
}

test('readDocument projects mode physical metadata losslessly', () => {
  const db = makeDb(); seed(db);
  const adapter = new ModeStorageAdapter(db, vectorSpy());
  assert.deepEqual(adapter.readDocument('file-a'), {
    id: 'file-a', sourceType: 'mode', name: 'guide.pdf',
    metadata: { modeId: 'mode-1', createdAt: '2026-09-12T10:00:00Z', pageCount: 4, extractedPageCount: 4 },
  });
  assert.equal(adapter.readDocument('missing'), null);
  db.close();
});

test('readChunks maps canonical fields, metadata, and physical numeric IDs', () => {
  const db = makeDb(); seed(db);
  const adapter = new ModeStorageAdapter(db, vectorSpy());
  const chunks = adapter.readChunks('file-a');
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0], { id: '1', documentId: 'file-a', text: 'alpha topic', pageStart: 1, pageEnd: 1, section: 'Intro', heading: 'Alpha', chunkIndex: 0, metadata: { source: 'fixture', contentType: 'text' } });
  assert.deepEqual(chunks[1], { id: '2', documentId: 'file-a', text: 'beta topic', pageStart: 2, pageEnd: 3, section: 'Body', heading: 'Beta', chunkIndex: 1, metadata: { source: 'fixture', contentType: 'table', tableIndex: 2 } });
  db.close();
});

test('readChunks safely ignores malformed metadata JSON', () => {
  const db = makeDb();
  db.prepare('INSERT INTO mode_reference_files VALUES (?, ?, ?, ?, ?, ?, ?)').run('file-x','mode-x','x.pdf','x','now',null,null);
  db.prepare(`INSERT INTO mode_reference_chunks (file_id,chunk_index,text,content_type,metadata_json) VALUES (?,?,?,?,?)`).run('file-x',0,'text','text','not-json');
  const adapter = new ModeStorageAdapter(db, vectorSpy());
  assert.deepEqual(adapter.readChunks('file-x')[0].metadata, { contentType: 'text' });
  db.close();
});

test('replaceChunks forwards canonical fields and preserves base metadata in chunk metadata', () => {
  const db = makeDb(); seed(db); TestDbManager.configure(db);
  const adapter = new ModeStorageAdapter(db, vectorSpy());
  const ids = adapter.replaceChunks('file-a', [{ id:'canonical-ignored', documentId:'file-a', text:'new text', chunkIndex:4, pageStart:7, pageEnd:8, section:'S', heading:'H', metadata:{contentType:'text', custom:'yes'} }], {batch:'b1'});
  assert.equal(ids.length, 1);
  const row = db.prepare('SELECT * FROM mode_reference_chunks WHERE file_id = ?').get('file-a');
  assert.equal(row.text, 'new text');
  assert.equal(row.chunk_index, 4);
  assert.deepEqual(JSON.parse(row.metadata_json), {batch:'b1', contentType:'text', custom:'yes'});
  assert.deepEqual(TestDbManager.calls[0].chunks[0], {
    text:'new text', chunkIndex:4, pageStart:7, pageEnd:8, section:'S', heading:'H', contentType:'text', tableIndex:undefined,
    metadata:{batch:'b1', contentType:'text', custom:'yes'}
  });
  assert.match(db.prepare('SELECT text FROM mode_reference_chunks_fts WHERE file_id = ?').get('file-a').text, /new text/);
  db.close();
});

test('clearEmbeddings and storeEmbedding delegate with embedding metadata intact', () => {
  const db = makeDb(); seed(db); const vector = vectorSpy();
  const adapter = new ModeStorageAdapter(db, vector);
  adapter.clearEmbeddings('file-a');
  adapter.storeEmbedding('12', { embedding:[0.1,0.2], space:'space-a', provider:'test', dimensions:2 });
  assert.deepEqual(vector.cleared, ['file-a']);
  assert.deepEqual(vector.stored, [[12,[0.1,0.2],'space-a','test',2]]);
  assert.throws(() => adapter.storeEmbedding('abc', {embedding:[1], space:'s'}), /numeric chunk id/);
  assert.throws(() => adapter.storeEmbedding(0, {embedding:[1], space:'s'}), /numeric chunk id/);
  db.close();
});

test('deleteDocumentIndex clears vectors then replaces only the selected document chunks', () => {
  const db = makeDb(); seed(db); TestDbManager.configure(db); const vector = vectorSpy();
  const adapter = new ModeStorageAdapter(db, vector);
  adapter.deleteDocumentIndex('file-a');
  assert.deepEqual(vector.cleared, ['file-a']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mode_reference_chunks WHERE file_id = ?').get('file-a').n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mode_reference_chunks WHERE file_id = ?').get('file-b').n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mode_reference_chunks_fts WHERE file_id = ?').get('file-a').n, 0);
  db.close();
});
