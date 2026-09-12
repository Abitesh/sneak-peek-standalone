import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function loadAdapter() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'personal-storage-adapter-'));
  const outfile = path.join(dir, 'adapter.mjs');
  const dbStub = `
    export class DatabaseManager {
      static active = null; static calls = [];
      static configure(db) { this.active = db; this.calls = []; }
      static getInstance() { return new DatabaseManager(); }
      replacePersonalFileChunks(documentId, chunks) {
        DatabaseManager.calls.push({ documentId, chunks });
        const db = DatabaseManager.active;
        const tx = db.transaction(() => {
          db.prepare('DELETE FROM personal_file_chunks WHERE file_id = ?').run(documentId);
          const ins = db.prepare(\`INSERT INTO personal_file_chunks
            (id, file_id, chunk_index, text, start_char, end_char, page_start, page_end, section, heading, content_type, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`);
          for (const c of chunks) ins.run(c.id, documentId, c.chunkIndex, c.text, c.startChar ?? 0, c.endChar ?? c.text.length,
            c.pageStart ?? null, c.pageEnd ?? null, c.section ?? null, c.heading ?? null, c.contentType ?? 'text', JSON.stringify(c.metadata ?? {}));
        }); tx();
        return db.prepare('SELECT id FROM personal_file_chunks WHERE file_id = ? ORDER BY chunk_index').all(documentId).map(r => String(r.id));
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
  await build({entryPoints:[path.join(process.cwd(),'electron/rag/storage/PersonalStorageAdapter.ts')], outfile, bundle:true, format:'esm', platform:'node', plugins:[plugin], external:['better-sqlite3']});
  return import(pathToFileURL(outfile).href + `?t=${Date.now()}`);
}

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE personal_files (
      id TEXT PRIMARY KEY, file_name TEXT, file_path TEXT, mime_type TEXT, size_bytes INTEGER,
      file_type TEXT, content_hash TEXT, created_at TEXT, updated_at TEXT, page_count INTEGER, extracted_page_count INTEGER
    );
    CREATE TABLE personal_file_chunks (
      id TEXT PRIMARY KEY, file_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, text TEXT NOT NULL,
      start_char INTEGER, end_char INTEGER, page_start INTEGER, page_end INTEGER, section TEXT, heading TEXT,
      content_type TEXT, metadata_json TEXT, UNIQUE(file_id, chunk_index),
      FOREIGN KEY(file_id) REFERENCES personal_files(id) ON DELETE CASCADE
    );
    CREATE VIRTUAL TABLE personal_file_chunks_fts USING fts5(chunk_id UNINDEXED, file_id UNINDEXED, file_name, text);
    CREATE TRIGGER personal_chunks_ai AFTER INSERT ON personal_file_chunks BEGIN
      INSERT INTO personal_file_chunks_fts(rowid, chunk_id, file_id, file_name, text)
      SELECT new.rowid, new.id, new.file_id, COALESCE((SELECT file_name FROM personal_files WHERE id = new.file_id), ''), new.text;
    END;
    CREATE TRIGGER personal_chunks_ad AFTER DELETE ON personal_file_chunks BEGIN
      DELETE FROM personal_file_chunks_fts WHERE rowid = old.rowid;
    END;
    CREATE TRIGGER personal_chunks_au AFTER UPDATE ON personal_file_chunks BEGIN
      DELETE FROM personal_file_chunks_fts WHERE rowid = old.rowid;
      INSERT INTO personal_file_chunks_fts(rowid, chunk_id, file_id, file_name, text)
      SELECT new.rowid, new.id, new.file_id, COALESCE((SELECT file_name FROM personal_files WHERE id = new.file_id), ''), new.text;
    END;
  `);
  return db;
}

function seed(db) {
  db.prepare('INSERT INTO personal_files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'doc-a','notes.pdf','/tmp/notes.pdf','application/pdf',1234,'pdf','hash-a','2026-09-12T10:00:00Z','2026-09-12T11:00:00Z',3,3
  );
  db.prepare('INSERT INTO personal_files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'doc-b','other.txt','/tmp/other.txt','text/plain',20,'txt','hash-b','2026-09-12T12:00:00Z','2026-09-12T12:00:00Z',1,1
  );
  const ins = db.prepare(`INSERT INTO personal_file_chunks
    (id,file_id,chunk_index,text,start_char,end_char,page_start,page_end,section,heading,content_type,metadata_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run('c-a1','doc-a',0,'alpha personal',0,14,1,1,'Intro','Alpha','text',JSON.stringify({source:'fixture'}));
  ins.run('c-a2','doc-a',1,'beta personal',15,27,2,2,'Body','Beta','table',JSON.stringify({source:'fixture', tableIndex:1}));
  ins.run('c-b1','doc-b',0,'other personal',0,13,1,1,null,null,'text','{}');
}

const mod = await loadAdapter();
const PersonalStorageAdapter = mod.PersonalStorageAdapter;
const TestDbManager = globalThis.__CHANGE25_TEST_DB_MANAGER__;
assert.ok(TestDbManager, 'DatabaseManager test hook was not initialized');

function vectorSpy() {
  return {
    cleared: [], stored: [],
    deletePersonalEmbeddingsForFile(id) { this.cleared.push(id); },
    storePersonalEmbedding(...args) { this.stored.push(args); },
  };
}

test('readDocument projects personal file metadata and identity', () => {
  const db = makeDb(); seed(db); const adapter = new PersonalStorageAdapter(db, vectorSpy());
  assert.deepEqual(adapter.readDocument('doc-a'), {
    id:'doc-a', sourceType:'personal', name:'notes.pdf', path:'/tmp/notes.pdf', mimeType:'application/pdf',
    metadata:{fileType:'pdf', sizeBytes:1234, contentHash:'hash-a', createdAt:'2026-09-12T10:00:00Z', updatedAt:'2026-09-12T11:00:00Z', pageCount:3, extractedPageCount:3}
  });
  assert.equal(adapter.readDocument('missing'), null);
  db.close();
});

test('readChunks maps offsets, pages, sections, headings and metadata', () => {
  const db = makeDb(); seed(db); const adapter = new PersonalStorageAdapter(db, vectorSpy());
  const chunks = adapter.readChunks('doc-a');
  assert.deepEqual(chunks[0], {id:'c-a1',documentId:'doc-a',text:'alpha personal',pageStart:1,pageEnd:1,section:'Intro',heading:'Alpha',chunkIndex:0,startOffset:0,endOffset:14,metadata:{source:'fixture',contentType:'text'}});
  assert.deepEqual(chunks[1], {id:'c-a2',documentId:'doc-a',text:'beta personal',pageStart:2,pageEnd:2,section:'Body',heading:'Beta',chunkIndex:1,startOffset:15,endOffset:27,metadata:{source:'fixture',tableIndex:1,contentType:'table'}});
  db.close();
});

test('readChunks safely ignores malformed metadata JSON', () => {
  const db = makeDb();
  db.prepare('INSERT INTO personal_files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('doc-x','x.txt','/x','text/plain',1,'txt','h','now','now',null,null);
  db.prepare(`INSERT INTO personal_file_chunks (id,file_id,chunk_index,text,metadata_json,content_type) VALUES (?,?,?,?,?,?)`).run('cx','doc-x',0,'x','bad-json','text');
  const adapter = new PersonalStorageAdapter(db, vectorSpy());
  assert.deepEqual(adapter.readChunks('doc-x')[0].metadata, {contentType:'text'});
  db.close();
});

test('replaceChunks preserves canonical string IDs and merges base metadata', () => {
  const db = makeDb(); seed(db); TestDbManager.configure(db);
  const adapter = new PersonalStorageAdapter(db, vectorSpy());
  const ids = adapter.replaceChunks('doc-a', [{id:'canonical-1',documentId:'doc-a',text:'replacement',chunkIndex:3,startOffset:10,endOffset:21,pageStart:4,pageEnd:4,section:'New',heading:'Heading',metadata:{contentType:'text',custom:'yes'}}], {batch:'b1'});
  assert.deepEqual(ids, ['canonical-1']);
  const row = db.prepare('SELECT * FROM personal_file_chunks WHERE file_id = ?').get('doc-a');
  assert.equal(row.id,'canonical-1');
  assert.equal(row.start_char,10); assert.equal(row.end_char,21);
  assert.deepEqual(JSON.parse(row.metadata_json), {batch:'b1',contentType:'text',custom:'yes'});
  assert.deepEqual(TestDbManager.calls[0].chunks[0], {
    id:'canonical-1',text:'replacement',chunkIndex:3,startChar:10,endChar:21,pageStart:4,pageEnd:4,section:'New',heading:'Heading',contentType:'text',metadata:{batch:'b1',contentType:'text',custom:'yes'}
  });
  assert.match(db.prepare('SELECT text FROM personal_file_chunks_fts WHERE file_id = ?').get('doc-a').text, /replacement/);
  db.close();
});

test('replaceChunks defaults offsets and content type without losing ID', () => {
  const db = makeDb(); TestDbManager.configure(db);
  db.prepare('INSERT INTO personal_files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('doc-a','a.txt','/a','text/plain',1,'txt','h','now','now',null,null);
  const adapter = new PersonalStorageAdapter(db, vectorSpy());
  assert.deepEqual(adapter.replaceChunks('doc-a', [{id:'c1',documentId:'doc-a',text:'hello',chunkIndex:0,metadata:{}}]), ['c1']);
  const row = db.prepare('SELECT start_char,end_char,content_type FROM personal_file_chunks WHERE id=?').get('c1');
  assert.deepEqual(row,{start_char:0,end_char:5,content_type:'text'});
  db.close();
});

test('clearEmbeddings and storeEmbedding delegate with embedding metadata intact', () => {
  const db = makeDb(); seed(db); const vector = vectorSpy(); const adapter = new PersonalStorageAdapter(db, vector);
  adapter.clearEmbeddings('doc-a');
  adapter.storeEmbedding('c-a1',{embedding:[0.1,0.2],space:'space-a',provider:'test',dimensions:2});
  assert.deepEqual(vector.cleared,['doc-a']);
  assert.deepEqual(vector.stored,[['c-a1',[0.1,0.2],'space-a','test',2]]);
  assert.throws(() => adapter.storeEmbedding(123,{embedding:[1],space:'s'}), /string chunk id/);
  db.close();
});

test('deleteDocumentIndex clears vectors and removes only the selected document chunks', () => {
  const db = makeDb(); seed(db); TestDbManager.configure(db); const vector = vectorSpy(); const adapter = new PersonalStorageAdapter(db, vector);
  adapter.deleteDocumentIndex('doc-a');
  assert.deepEqual(vector.cleared,['doc-a']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM personal_file_chunks WHERE file_id=?').get('doc-a').n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM personal_file_chunks WHERE file_id=?').get('doc-b').n,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM personal_file_chunks_fts WHERE file_id=?').get('doc-a').n,0);
  db.close();
});
