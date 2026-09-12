// electron/rag/storage/ModeStorageAdapter.ts
// Change 25 — Mode reference-file storage adapter.
//
// Physical storage remains exactly where it was: mode_reference_files and
// mode_reference_chunks in the existing SQLite database, with FTS5 maintained
// by the existing SQLite triggers and embeddings maintained by VectorStore.
// No new generic RAG tables are introduced by this adapter.

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

export class ModeStorageAdapter implements DocumentStorageAdapter {
  readonly sourceType = 'mode' as const;

  constructor(
    private readonly db: Database.Database,
    private readonly vectorStore: VectorStore,
  ) {}

  readDocument(documentId: string): RagDocument | null {
    const row = this.db.prepare(`
      SELECT id, mode_id, file_name, content, created_at, page_count, extracted_page_count
      FROM mode_reference_files
      WHERE id = ?
      LIMIT 1
    `).get(documentId) as any;

    if (!row) return null;
    return {
      id: String(row.id),
      sourceType: 'mode',
      name: String(row.file_name ?? row.id),
      metadata: {
        ...(row.mode_id ? { modeId: String(row.mode_id) } : {}),
        ...(row.created_at ? { createdAt: row.created_at } : {}),
        ...(row.page_count !== null && row.page_count !== undefined ? { pageCount: row.page_count } : {}),
        ...(row.extracted_page_count !== null && row.extracted_page_count !== undefined
          ? { extractedPageCount: row.extracted_page_count }
          : {}),
      },
    };
  }

  readChunks(documentId: string): RagChunk[] {
    const rows = this.db.prepare(`
      SELECT id, file_id, chunk_index, text,
             page_start, page_end, section, heading, content_type,
             table_index, metadata_json
      FROM mode_reference_chunks
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
      metadata: {
        ...parseMetadata(row.metadata_json),
        ...(row.content_type ? { contentType: row.content_type } : {}),
        ...(row.table_index !== null && row.table_index !== undefined ? { tableIndex: row.table_index } : {}),
      },
    }));
  }

  replaceChunks(
    documentId: string,
    chunks: readonly RagChunk[],
    baseMetadata: Record<string, unknown> = {},
  ): number[] {
    // Mode chunk identity is owned by the existing SQLite AUTOINCREMENT key.
    // The adapter preserves the canonical RagChunk shape for reads, but does
    // not introduce a new mode chunk-ID scheme on writes.
    return DatabaseManager.getInstance().replaceModeReferenceChunks(
      documentId,
      chunks.map((chunk) => ({
        text: chunk.text,
        chunkIndex: chunk.chunkIndex,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        section: chunk.section,
        heading: chunk.heading,
        contentType: typeof chunk.metadata?.contentType === 'string'
          ? chunk.metadata.contentType
          : 'text',
        tableIndex: typeof chunk.metadata?.tableIndex === 'number'
          ? chunk.metadata.tableIndex
          : undefined,
        metadata: {
          ...baseMetadata,
          ...(chunk.metadata ?? {}),
        },
      })),
      {},
    );
  }

  clearEmbeddings(documentId: string): void {
    this.vectorStore.deleteModeReferenceEmbeddingsForFile(documentId);
  }

  storeEmbedding(chunkId: number | string, embedding: StoredRagEmbedding): void {
    const numericChunkId = typeof chunkId === 'number' ? chunkId : Number(chunkId);
    if (!Number.isInteger(numericChunkId) || numericChunkId < 1) {
      throw new Error(`Mode storage requires a numeric chunk id, received ${String(chunkId)}`);
    }
    this.vectorStore.storeModeReferenceEmbedding(
      numericChunkId,
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
