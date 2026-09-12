// electron/rag/storage/PersonalStorageAdapter.ts
// Change 25 — Personal File storage adapter.
//
// Physical storage remains exactly where it was: personal_files and
// personal_file_chunks in the existing SQLite database, with FTS5 maintained
// by the existing SQLite triggers and embeddings maintained by VectorStore.
// No new generic RAG tables are introduced in this first storage slice.

import Database from 'better-sqlite3';
import { DatabaseManager } from '../../db/DatabaseManager';
import type { RagChunk, RagDocument, StoredRagEmbedding } from './RagStorageTypes';
import type { DocumentStorageAdapter } from './DocumentStorageAdapter';
import { VectorStore } from '../VectorStore';

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}



export class PersonalStorageAdapter implements DocumentStorageAdapter {
  readonly sourceType = 'personal' as const;

  constructor(
    private readonly db: Database.Database,
    private readonly vectorStore: VectorStore,
  ) {}

  readDocument(documentId: string): RagDocument | null {
    const row = this.db.prepare(`
      SELECT id, file_name, file_path, mime_type, size_bytes, file_type,
             content_hash, created_at, updated_at, page_count, extracted_page_count
      FROM personal_files
      WHERE id = ?
      LIMIT 1
    `).get(documentId) as any;

    if (!row) return null;
    return {
      id: String(row.id),
      sourceType: 'personal',
      name: String(row.file_name ?? row.id),
      ...(row.file_path ? { path: String(row.file_path) } : {}),
      ...(row.mime_type ? { mimeType: String(row.mime_type) } : {}),
      metadata: {
        ...(row.file_type !== undefined ? { fileType: row.file_type } : {}),
        ...(row.size_bytes !== undefined ? { sizeBytes: row.size_bytes } : {}),
        ...(row.content_hash ? { contentHash: row.content_hash } : {}),
        ...(row.created_at ? { createdAt: row.created_at } : {}),
        ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
        ...(row.page_count !== null && row.page_count !== undefined ? { pageCount: row.page_count } : {}),
        ...(row.extracted_page_count !== null && row.extracted_page_count !== undefined
          ? { extractedPageCount: row.extracted_page_count }
          : {}),
      },
    };
  }

  readChunks(documentId: string): RagChunk[] {
    const rows = this.db.prepare(`
      SELECT id, file_id, chunk_index, text, start_char, end_char,
             page_start, page_end, section, heading, content_type, metadata_json
      FROM personal_file_chunks
      WHERE file_id = ?
      ORDER BY chunk_index ASC
    `).all(documentId) as any[];

    return rows.map((row) => ({
      id: String(row.id),
      documentId: String(row.file_id),
      text: String(row.text ?? ''),
      ...(row.page_start !== null && row.page_start !== undefined ? { pageStart: row.page_start } : {}),
      ...(row.page_end !== null && row.page_end !== undefined ? { pageEnd: row.page_end } : {}),
      ...(row.section ? { section: String(row.section) } : {}),
      ...(row.heading ? { heading: String(row.heading) } : {}),
      chunkIndex: Number(row.chunk_index),
      ...(row.start_char !== null && row.start_char !== undefined ? { startOffset: row.start_char } : {}),
      ...(row.end_char !== null && row.end_char !== undefined ? { endOffset: row.end_char } : {}),
      metadata: {
        ...parseMetadata(row.metadata_json),
        ...(row.content_type ? { contentType: row.content_type } : {}),
      },
    }));
  }

  replaceChunks(
    documentId: string,
    chunks: readonly RagChunk[],
    baseMetadata: Record<string, unknown> = {},
  ): string[] {
    const rows = chunks.map((chunk) => ({
      ...chunk,
      id: chunk.id,
    }));

    // Use the existing DatabaseManager method so the transaction and FTS5
    // trigger semantics remain exactly those already proven in Change 22.
    return DatabaseManager.getInstance().replacePersonalFileChunks(
      documentId,
      rows.map((chunk) => ({
        id: chunk.id,
        text: chunk.text,
        chunkIndex: chunk.chunkIndex,
        startChar: chunk.startOffset ?? 0,
        endChar: chunk.endOffset ?? chunk.text.length,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        section: chunk.section,
        heading: chunk.heading,
        contentType: typeof chunk.metadata?.contentType === 'string'
          ? chunk.metadata.contentType
          : 'text',
        metadata: {
          ...baseMetadata,
          ...(chunk.metadata ?? {}),
        },
      })),
    );
  }

  clearEmbeddings(documentId: string): void {
    this.vectorStore.deletePersonalEmbeddingsForFile(documentId);
  }

  storeEmbedding(chunkId: number | string, embedding: StoredRagEmbedding): void {
    if (typeof chunkId !== 'string') {
      throw new Error(`Personal storage requires a string chunk id, received ${typeof chunkId}`);
    }
    this.vectorStore.storePersonalEmbedding(
      chunkId,
      embedding.embedding,
      embedding.space,
      embedding.provider,
      embedding.dimensions,
    );
  }

  deleteDocumentIndex(documentId: string): void {
    this.clearEmbeddings(documentId);
    this.replaceChunks(documentId, [], {});
  }
}
