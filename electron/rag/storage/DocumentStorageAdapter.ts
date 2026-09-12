// electron/rag/storage/DocumentStorageAdapter.ts
// Change 25 — source-specific storage boundary for the unified RAG pipeline.
//
// This is deliberately a storage contract, not a retrieval contract. Retrieval
// remains behind RagSourceAdapter and its existing source-specific adapters.
// The first Change 25 slice keeps the existing SQLite tables authoritative and
// introduces no new schema or second source of truth.

import type { RagChunk, RagDocument, StoredRagEmbedding } from './RagStorageTypes';
import type { RagIndexSourceType } from '../RAGManager';

export interface DocumentStorageAdapter {
  readonly sourceType: RagIndexSourceType;

  readDocument(documentId: string): RagDocument | null;
  readChunks(documentId: string): RagChunk[];

  /** Replace the source's lexical/chunk index. Existing FTS triggers remain authoritative. */
  replaceChunks(
    documentId: string,
    chunks: readonly RagChunk[],
    baseMetadata?: Record<string, unknown>,
  ): Array<number | string>;

  /** Remove all source-specific semantic vectors before replacement/deletion. */
  clearEmbeddings(documentId: string): void;

  /** Persist one embedding through the existing VectorStore boundary. */
  storeEmbedding(chunkId: number | string, embedding: StoredRagEmbedding): void;

  /** Remove the complete source-specific index while preserving the source document row. */
  deleteDocumentIndex(documentId: string): void;
}
