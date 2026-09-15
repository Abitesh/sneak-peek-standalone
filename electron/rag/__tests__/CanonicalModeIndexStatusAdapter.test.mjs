import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const distPath = path.resolve(process.cwd(), 'dist-electron/electron/rag/canonical/CanonicalModeIndexStatusAdapter.js');
const schemaPath = path.resolve(process.cwd(), 'dist-electron/electron/rag/canonical/CanonicalRagSchema.js');
const retrieverPath = path.resolve(process.cwd(), 'dist-electron/electron/services/modes/ModeHybridRetriever.js');
const { CanonicalModeIndexStatusAdapter } = await import(pathToFileURL(distPath).href);
const { installCanonicalRagSchema } = await import(pathToFileURL(schemaPath).href);
const { ModeHybridRetriever } = await import(pathToFileURL(retrieverPath).href);

function makeDb() {
  const db = new Database(':memory:');
  installCanonicalRagSchema(db);
  return db;
}

function seedModeDocument(db, {
  fileId = 'file-1',
  sourceId = 'file-1',
  docId = 'doc-1',
  revisionId = 'rev-1',
  contentHash = 'hash-abc',
  status = 'READY',
  chunkCount = 2,
  embeddingSpace = 'gemini:embedding-001:768',
  activeSpace = 'gemini:embedding-001:768',
  embeddedChunkCount = 1,
} = {}) {
  db.prepare(`
    INSERT INTO rag_documents (
      id, source_type, source_id, owner_id, scope_id, name, path, mime_type, file_type,
      size_bytes, content_hash, created_at, updated_at, current_revision_id, deleted_at, metadata_json
    ) VALUES (?, 'mode', ?, NULL, NULL, 'test.pdf', NULL, 'application/pdf', 'pdf', 123, ?, ?, ?, NULL, NULL, '{}')
  `).run(docId, sourceId, contentHash, new Date().toISOString(), new Date().toISOString());

  db.prepare(`
    INSERT INTO rag_document_revisions (
      id, document_id, revision_number, content_hash, extraction_version, chunking_version,
      normalization_version, extraction_state, created_at, superseded_at, metadata_json
    ) VALUES (?, ?, 1, ?, 'v1', 'v1', 'v1', 'EXTRACTED', ?, NULL, '{}')
  `).run(revisionId, docId, contentHash, new Date().toISOString());

  db.prepare(`UPDATE rag_documents SET current_revision_id = ? WHERE id = ?`).run(revisionId, docId);

  if (embeddingSpace) {
    db.prepare(`
      INSERT OR IGNORE INTO rag_embedding_spaces (id, provider, model, dimensions, metric, version, created_at, retired_at, vector_table_key, metadata_json)
      VALUES (?, 'gemini', 'embedding-001', 768, 'cosine', 'v1', ?, NULL, 1, '{}')
    `).run(embeddingSpace, new Date().toISOString());
  }

  db.prepare(`
    INSERT OR IGNORE INTO rag_chunks (
      id, document_id, revision_id, chunk_index, text, content_hash, page_start, page_end,
      section, heading, content_type, start_char, end_char, table_index, token_count,
      speaker, timestamp_start, timestamp_end, source_locator, metadata_json, created_at
    ) VALUES (?, ?, ?, 0, 'alpha', ?, 1, 1, NULL, NULL, 'text', 0, 5, NULL, 10, NULL, NULL, NULL, NULL, '{}', ?)
  `).run('chunk-1', docId, revisionId, contentHash, new Date().toISOString());

  db.prepare(`
    INSERT OR IGNORE INTO rag_chunks (
      id, document_id, revision_id, chunk_index, text, content_hash, page_start, page_end,
      section, heading, content_type, start_char, end_char, table_index, token_count,
      speaker, timestamp_start, timestamp_end, source_locator, metadata_json, created_at
    ) VALUES (?, ?, ?, 1, 'beta', ?, 2, 2, NULL, NULL, 'text', 6, 10, NULL, 10, NULL, NULL, NULL, NULL, '{}', ?)
  `).run('chunk-2', docId, revisionId, contentHash, new Date().toISOString());

  if (embeddingSpace) {
    const vectorBlob = Buffer.from(new Float32Array([1, 2, 3]).buffer);
    db.prepare(`
      INSERT OR IGNORE INTO rag_embeddings (id, chunk_id, embedding_space_id, physical_row_key, vector, created_at, metadata_json)
      VALUES (?, ?, ?, 1, ?, ?, '{}')
    `).run('emb-1', 'chunk-1', embeddingSpace, vectorBlob, new Date().toISOString());
  }

  db.prepare(`
    INSERT INTO rag_canonical_index_status (
      document_id, revision_id, status, chunk_count, embedded_chunk_count,
      extracted_page_count, total_page_count, error_code, error_message, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)
  `).run(docId, revisionId, status, chunkCount, embeddedChunkCount, Date.now());

  return { docId, revisionId, fileId, activeSpace };
}

function makePipeline({ space = 'gemini:embedding-001:768', ready = true } = {}) {
  return {
    isReady: () => ready,
    getActiveSpaceKey: () => (ready ? space : undefined),
    getEmbeddingForQuery: async () => [1, 0, 0, 0],
    getEmbeddings: async () => [[1, 0, 0, 0]],
    getEmbeddingsWithFallback: async (texts) => ({ embeddings: texts.map(() => [1, 0, 0, 0]), space }),
  };
}

describe('CanonicalModeIndexStatusAdapter: lifecycle and semantics', () => {
  test('maps canonical lifecycle states to the legacy Mode contract', () => {
    const lifecycle = [
      ['NOT_INDEXED', 'pending'],
      ['QUEUED', 'pending'],
      ['EXTRACTING', 'indexing'],
      ['CHUNKING', 'indexing'],
      ['EMBEDDING', 'indexing'],
      ['READY', 'ready'],
      ['FAILED', 'failed'],
      ['OCR_REQUIRED', 'ocr_required'],
    ];

    for (const [status, expected] of lifecycle) {
      const db = makeDb();
      seedModeDocument(db, {
        status,
        chunkCount: 2,
        embeddingSpace: status === 'READY' ? 'gemini:embedding-001:768' : null,
        embeddedChunkCount: status === 'READY' ? 2 : 0,
      });
      const state = new CanonicalModeIndexStatusAdapter(db).resolve('file-1', { activeEmbeddingSpace: 'gemini:embedding-001:768' });
      assert.equal(state?.status, expected, `status ${status} should become ${expected}`);
      db.close();
    }
  });

  test('LEXICAL_READY with embedded count zero is lexical_only, but inconsistent counts remain incomplete and fall back', () => {
    const dbReady = makeDb();
    seedModeDocument(dbReady, { status: 'LEXICAL_READY', chunkCount: 1, embeddingSpace: null, embeddedChunkCount: 0 });
    const lexicalOnly = new CanonicalModeIndexStatusAdapter(dbReady).resolve('file-1', { activeEmbeddingSpace: 'gemini:embedding-001:768' });
    assert.equal(lexicalOnly?.status, 'lexical_only');
    dbReady.close();

    const dbIncomplete = makeDb();
    seedModeDocument(dbIncomplete, { status: 'LEXICAL_READY', chunkCount: 3, embeddingSpace: 'gemini:embedding-001:768', embeddedChunkCount: 1 });
    const incomplete = new CanonicalModeIndexStatusAdapter(dbIncomplete).resolve('file-1', { activeEmbeddingSpace: 'gemini:embedding-001:768' });
    assert.equal(incomplete, null);
    dbIncomplete.close();
  });

  test('READY space identity uses embeddingSpaceKey so models/ prefixes match the live pipeline', () => {
    const db = makeDb();
    const docId = 'doc-models-prefix';
    const revisionId = 'rev-models-prefix';
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO rag_documents (
        id, source_type, source_id, owner_id, scope_id, name, path, mime_type, file_type,
        size_bytes, content_hash, created_at, updated_at, current_revision_id, deleted_at, metadata_json
      ) VALUES (?, 'mode', 'file-models', NULL, NULL, 'doc.pdf', NULL, 'application/pdf', 'pdf', 123, 'hash', ?, ?, NULL, NULL, '{}')
    `).run(docId, now, now);
    db.prepare(`INSERT INTO rag_document_revisions (id, document_id, revision_number, content_hash, extraction_version, chunking_version, normalization_version, extraction_state, created_at, superseded_at, metadata_json) VALUES (?, ?, 1, 'hash', 'v1', 'v1', 'v1', 'EXTRACTED', ?, NULL, '{}')`).run(revisionId, docId, now);
    db.prepare('UPDATE rag_documents SET current_revision_id = ? WHERE id = ?').run(revisionId, docId);
    db.prepare(`INSERT INTO rag_embedding_spaces (id, provider, model, dimensions, metric, version, created_at, retired_at, vector_table_key, metadata_json) VALUES ('space-uuid', 'gemini', 'models/gemini-embedding-001', 768, 'cosine', 'pipeline-v1', ?, NULL, 1, '{}')`).run(now);
    db.prepare(`INSERT INTO rag_chunks (id, document_id, revision_id, chunk_index, text, content_hash, page_start, page_end, section, heading, content_type, start_char, end_char, table_index, token_count, speaker, timestamp_start, timestamp_end, source_locator, metadata_json, created_at) VALUES ('chunk-models', ?, ?, 0, 'alpha', 'hash', 1, 1, NULL, NULL, 'text', 0, 5, NULL, 10, NULL, NULL, NULL, NULL, '{}', ?)`).run(docId, revisionId, now);
    db.prepare(`INSERT INTO rag_embeddings (id, chunk_id, embedding_space_id, physical_row_key, vector, created_at, metadata_json) VALUES ('emb-models', 'chunk-models', 'space-uuid', 1, ?, ?, '{}')`).run(Buffer.from(new Float32Array([1, 2, 3]).buffer), now);
    db.prepare(`INSERT INTO rag_canonical_index_status (document_id, revision_id, status, chunk_count, embedded_chunk_count, extracted_page_count, total_page_count, error_code, error_message, updated_at) VALUES (?, ?, 'READY', 1, 1, NULL, NULL, NULL, NULL, ?)`).run(docId, revisionId, Date.now());

    const state = new CanonicalModeIndexStatusAdapter(db).resolve('file-models', {
      activeEmbeddingSpace: 'gemini:gemini-embedding-001:768',
    });
    assert.equal(state?.status, 'ready');
    assert.equal(state?.embeddingSpace, 'gemini:gemini-embedding-001:768');
    db.close();
  });

  test('READY resolves to ready only when the embedding space matches and returns null without a canonical embedding space', () => {
    const dbReady = makeDb();
    seedModeDocument(dbReady, { status: 'READY', chunkCount: 2, embeddingSpace: 'gemini:embedding-001:768', embeddedChunkCount: 2 });
    const ready = new CanonicalModeIndexStatusAdapter(dbReady).resolve('file-1', { activeEmbeddingSpace: 'gemini:embedding-001:768' });
    assert.equal(ready?.status, 'ready');
    dbReady.close();

    const dbMismatch = makeDb();
    seedModeDocument(dbMismatch, { status: 'READY', chunkCount: 2, embeddingSpace: 'gemini:embedding-001:768', embeddedChunkCount: 2 });
    const mismatch = new CanonicalModeIndexStatusAdapter(dbMismatch).resolve('file-1', { activeEmbeddingSpace: 'openai:text-embedding-3-small:1536' });
    assert.equal(mismatch?.status, 'pending');
    dbMismatch.close();

    const dbNoSpace = makeDb();
    seedModeDocument(dbNoSpace, { status: 'READY', chunkCount: 2, embeddingSpace: null, embeddedChunkCount: 0 });
    const noSpace = new CanonicalModeIndexStatusAdapter(dbNoSpace).resolve('file-1', { activeEmbeddingSpace: 'gemini:embedding-001:768' });
    assert.equal(noSpace, null);
    dbNoSpace.close();
  });

  test('current_revision_id is authoritative over the newest revision row and fileHash matches the active revision', () => {
    const db = makeDb();
    const docId = 'doc-revision-authority';
    const revisionA = 'rev-A';
    const revisionB = 'rev-B';

    db.prepare(`
      INSERT INTO rag_documents (
        id, source_type, source_id, owner_id, scope_id, name, path, mime_type, file_type,
        size_bytes, content_hash, created_at, updated_at, current_revision_id, deleted_at, metadata_json
      ) VALUES (?, 'mode', ?, NULL, NULL, 'doc.pdf', NULL, 'application/pdf', 'pdf', 123, ?, ?, ?, NULL, NULL, '{}')
    `).run(docId, 'doc-revision-authority', 'hash-A', new Date().toISOString(), new Date().toISOString());

    db.prepare(`INSERT INTO rag_document_revisions (id, document_id, revision_number, content_hash, extraction_version, chunking_version, normalization_version, extraction_state, created_at, superseded_at, metadata_json) VALUES (?, ?, 1, ?, 'v1', 'v1', 'v1', 'EXTRACTED', ?, NULL, '{}')`).run(revisionA, docId, 'hash-A', new Date().toISOString());
    db.prepare(`INSERT INTO rag_document_revisions (id, document_id, revision_number, content_hash, extraction_version, chunking_version, normalization_version, extraction_state, created_at, superseded_at, metadata_json) VALUES (?, ?, 2, ?, 'v1', 'v1', 'v1', 'EXTRACTED', ?, NULL, '{}')`).run(revisionB, docId, 'hash-B', new Date().toISOString());
    db.prepare(`UPDATE rag_documents SET current_revision_id = ? WHERE id = ?`).run(revisionA, docId);

    db.prepare(`INSERT INTO rag_canonical_index_status (document_id, revision_id, status, chunk_count, embedded_chunk_count, extracted_page_count, total_page_count, error_code, error_message, updated_at) VALUES (?, ?, 'READY', 2, 2, NULL, NULL, NULL, NULL, ?)`).run(docId, revisionA, Date.now());
    db.prepare(`INSERT INTO rag_canonical_index_status (document_id, revision_id, status, chunk_count, embedded_chunk_count, extracted_page_count, total_page_count, error_code, error_message, updated_at) VALUES (?, ?, 'FAILED', 2, 0, NULL, NULL, NULL, NULL, ?)`).run(docId, revisionB, Date.now());

    db.prepare(`INSERT INTO rag_embedding_spaces (id, provider, model, dimensions, metric, version, created_at, retired_at, vector_table_key, metadata_json) VALUES (?, 'gemini', 'embedding-001', 768, 'cosine', 'v1', ?, NULL, 1, '{}')`).run('gemini:embedding-001:768', new Date().toISOString());
    const blob = Buffer.from(new Float32Array([1, 2, 3]).buffer);
    db.prepare(`INSERT INTO rag_chunks (id, document_id, revision_id, chunk_index, text, content_hash, page_start, page_end, section, heading, content_type, start_char, end_char, table_index, token_count, speaker, timestamp_start, timestamp_end, source_locator, metadata_json, created_at) VALUES (?, ?, ?, 0, 'alpha', ?, 1, 1, NULL, NULL, 'text', 0, 5, NULL, 10, NULL, NULL, NULL, NULL, '{}', ?)`).run('rev-A-chunk-1', docId, revisionA, 'hash-A', new Date().toISOString());
    db.prepare(`INSERT INTO rag_embeddings (id, chunk_id, embedding_space_id, physical_row_key, vector, created_at, metadata_json) VALUES (?, ?, ?, 1, ?, ?, '{}')`).run('emb-rev-a-1', 'rev-A-chunk-1', 'gemini:embedding-001:768', blob, new Date().toISOString());

    const adapter = new CanonicalModeIndexStatusAdapter(db);
    const before = adapter.resolve('doc-revision-authority', { activeEmbeddingSpace: 'gemini:embedding-001:768' });
    assert.equal(before?.fileHash, 'hash-A');
    assert.equal(before?.status, 'ready');

    db.prepare(`UPDATE rag_documents SET current_revision_id = ? WHERE id = ?`).run(revisionB, docId);
    const after = adapter.resolve('doc-revision-authority', { activeEmbeddingSpace: 'gemini:embedding-001:768' });
    assert.equal(after?.fileHash, 'hash-B');
    assert.equal(after?.status, 'failed');
    db.close();
  });

  test('hash parity uses the current canonical revision content_hash exactly', () => {
    const db = makeDb();
    seedModeDocument(db, { contentHash: 'hash-xyz', status: 'READY', embeddingSpace: 'gemini:embedding-001:768', embeddedChunkCount: 2 });
    const state = new CanonicalModeIndexStatusAdapter(db).resolve('file-1', { activeEmbeddingSpace: 'gemini:embedding-001:768' });
    assert.equal(state?.fileHash, 'hash-xyz');
    db.close();
  });
});

describe('ModeHybridRetriever: legacy fallback and public status surface', () => {
  test('falls back to the legacy mode_reference_index_state row when the canonical document is missing', () => {
    const db = makeDb();
    const retriever = new ModeHybridRetriever(db, {}, makePipeline());
    db.prepare('INSERT INTO mode_reference_index_state (file_id, file_hash, indexed_at, chunk_count, status, embedding_space) VALUES (?, ?, ?, ?, ?, ?)')
      .run('legacy-only', 'legacy-hash', Date.now(), 3, 'failed', 'gemini:embedding-001:768');

    const state = retriever['getIndexState']('legacy-only');
    assert.deepEqual(state, {
      fileId: 'legacy-only',
      fileHash: 'legacy-hash',
      indexedAt: state.indexedAt,
      chunkCount: 3,
      status: 'failed',
      embeddingSpace: 'gemini:embedding-001:768',
    });
    db.close();
  });

  test('falls back when the canonical document exists but the canonical status row is incomplete', () => {
    const db = makeDb();
    const retriever = new ModeHybridRetriever(db, {}, makePipeline());
    db.prepare(`INSERT INTO rag_documents (id, source_type, source_id, owner_id, scope_id, name, path, mime_type, file_type, size_bytes, content_hash, created_at, updated_at, current_revision_id, deleted_at, metadata_json) VALUES (?, 'mode', ?, NULL, NULL, 'legacy.pdf', NULL, 'application/pdf', 'pdf', 123, ?, ?, ?, NULL, NULL, '{}')`).run('doc-legacy', 'legacy-file', 'hash-legacy', new Date().toISOString(), new Date().toISOString());
    db.prepare(`INSERT INTO rag_document_revisions (id, document_id, revision_number, content_hash, extraction_version, chunking_version, normalization_version, extraction_state, created_at, superseded_at, metadata_json) VALUES (?, ?, 1, ?, 'v1', 'v1', 'v1', 'EXTRACTED', ?, NULL, '{}')`).run('rev-legacy', 'doc-legacy', 'hash-legacy', new Date().toISOString());
    db.prepare(`UPDATE rag_documents SET current_revision_id = ? WHERE id = ?`).run('rev-legacy', 'doc-legacy');
    db.prepare('INSERT INTO mode_reference_index_state (file_id, file_hash, indexed_at, chunk_count, status, embedding_space) VALUES (?, ?, ?, ?, ?, ?)')
      .run('legacy-file', 'legacy-hash', Date.now(), 2, 'lexical_only', 'gemini:embedding-001:768');

    const state = retriever['getIndexState']('legacy-file');
    assert.equal(state?.status, 'lexical_only');
    assert.equal(state?.fileHash, 'legacy-hash');
    db.close();
  });

  test('public getFileIndexStatus preserves the exact status shape and falls back correctly', () => {
    const db = makeDb();
    const retriever = new ModeHybridRetriever(db, {}, makePipeline({ space: 'gemini:embedding-001:768' }));

    db.prepare('INSERT INTO mode_reference_index_state (file_id, file_hash, indexed_at, chunk_count, status, embedding_space) VALUES (?, ?, ?, ?, ?, ?)')
      .run('ready-match', 'h-ready', Date.now(), 4, 'ready', 'gemini:embedding-001:768');
    assert.deepEqual(retriever.getFileIndexStatus('ready-match'), { status: 'ready', chunkCount: 4 });

    db.prepare('UPDATE mode_reference_index_state SET status = ?, embedding_space = ? WHERE file_id = ?')
      .run('ready', 'openai:text-embedding-3-small:1536', 'ready-match');
    assert.deepEqual(retriever.getFileIndexStatus('ready-match'), { status: 'pending', chunkCount: 4 });

    db.prepare('INSERT INTO mode_reference_index_state (file_id, file_hash, indexed_at, chunk_count, status, embedding_space) VALUES (?, ?, ?, ?, ?, ?)')
      .run('failed-id', 'h-failed', Date.now(), 5, 'failed', 'gemini:embedding-001:768');
    assert.deepEqual(retriever.getFileIndexStatus('failed-id'), { status: 'failed', chunkCount: 5 });

    db.prepare('INSERT INTO mode_reference_index_state (file_id, file_hash, indexed_at, chunk_count, status, embedding_space) VALUES (?, ?, ?, ?, ?, ?)')
      .run('lexical-id', 'h-lex', Date.now(), 2, 'lexical_only', 'gemini:embedding-001:768');
    assert.deepEqual(retriever.getFileIndexStatus('lexical-id'), { status: 'lexical_only', chunkCount: 2 });

    db.prepare('INSERT INTO mode_reference_index_state (file_id, file_hash, indexed_at, chunk_count, status, embedding_space) VALUES (?, ?, ?, ?, ?, ?)')
      .run('ocr-id', 'h-ocr', Date.now(), 2, 'ocr_required', 'gemini:embedding-001:768');
    assert.deepEqual(retriever.getFileIndexStatus('ocr-id'), { status: 'ocr_required', chunkCount: 2 });

    db.prepare('INSERT INTO mode_reference_index_state (file_id, file_hash, indexed_at, chunk_count, status, embedding_space) VALUES (?, ?, ?, ?, ?, ?)')
      .run('legacy-id', 'h-legacy', Date.now(), 1, 'pending', 'gemini:embedding-001:768');
    assert.deepEqual(retriever.getFileIndexStatus('legacy-id'), { status: 'pending', chunkCount: 1 });
    db.close();
  });

  test('legacy writer compatibility: persistent update and delete still work', () => {
    const db = makeDb();
    const retriever = new ModeHybridRetriever(db, {}, makePipeline());
    retriever['updateIndexState']('writer-file', 'writer-hash', 7, 'failed', 'gemini:embedding-001:768');

    const row = db.prepare('SELECT file_id, file_hash, chunk_count, status, embedding_space FROM mode_reference_index_state WHERE file_id = ?').get('writer-file');
    assert.equal(row.status, 'failed');
    assert.equal(row.chunk_count, 7);
    assert.equal(row.embedding_space, 'gemini:embedding-001:768');

    retriever['removeIndexState']('writer-file');
    const deleted = db.prepare('SELECT COUNT(*) AS n FROM mode_reference_index_state WHERE file_id = ?').get('writer-file');
    assert.equal(deleted.n, 0);
    db.close();
  });

  test('failure isolation keeps the legacy fallback active when canonical lookup cannot complete', () => {
    const db = makeDb();
    const retriever = new ModeHybridRetriever(db, {}, makePipeline());
    db.prepare('INSERT INTO mode_reference_index_state (file_id, file_hash, indexed_at, chunk_count, status, embedding_space) VALUES (?, ?, ?, ?, ?, ?)')
      .run('broken-canonical', 'legacy-fallback-hash', Date.now(), 2, 'ready', 'gemini:embedding-001:768');
    db.prepare('DROP TABLE rag_documents').run();

    const state = retriever['getIndexState']('broken-canonical');
    assert.equal(state?.status, 'ready');
    assert.equal(state?.fileHash, 'legacy-fallback-hash');
    db.close();
  });
});
