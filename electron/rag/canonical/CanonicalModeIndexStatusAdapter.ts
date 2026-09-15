import type Database from 'better-sqlite3';
import { embeddingSpaceKey } from '../embeddingSpace';

export type CanonicalModeStatus =
  | 'pending'
  | 'indexing'
  | 'ready'
  | 'failed'
  | 'lexical_only'
  | 'ocr_required';

export interface CanonicalModeIndexState {
  fileId: string;
  fileHash: string;
  indexedAt: number;
  chunkCount: number;
  status: CanonicalModeStatus;
  embeddingSpace: string | null;
}

export interface CanonicalModeIndexStatusAdapterOptions {
  activeEmbeddingSpace?: string | null;
}

export class CanonicalModeIndexStatusAdapter {
  constructor(private readonly db: Database.Database) {}

  resolve(fileId: string, options: CanonicalModeIndexStatusAdapterOptions = {}): CanonicalModeIndexState | null {
    const activeSpace = options.activeEmbeddingSpace ?? null;

    try {
      const documentRow = this.db.prepare(`
        SELECT id, source_id, current_revision_id
        FROM rag_documents
        WHERE source_type = 'mode' AND source_id = ?
        LIMIT 1
      `).get(fileId) as { id: string; source_id: string; current_revision_id: string | null } | undefined;

      if (!documentRow || !documentRow.current_revision_id) return null;

      const revisionRow = this.db.prepare(`
        SELECT id, content_hash
        FROM rag_document_revisions
        WHERE id = ?
        LIMIT 1
      `).get(documentRow.current_revision_id) as { id: string; content_hash: string } | undefined;

      if (!revisionRow) return null;

      const statusRow = this.db.prepare(`
        SELECT status, chunk_count, embedded_chunk_count, updated_at
        FROM rag_canonical_index_status
        WHERE document_id = ? AND revision_id = ?
        LIMIT 1
      `).get(documentRow.id, revisionRow.id) as { status: string; chunk_count: number; embedded_chunk_count: number; updated_at: number } | undefined;

      if (!statusRow) return null;

      const chunkCount = Number(statusRow.chunk_count ?? 0);
      const embeddedChunkCount = Number(statusRow.embedded_chunk_count ?? 0);
      const embeddingSpace = this.resolveEmbeddingSpace(revisionRow.id);
      const modeStatus = this.mapStatus(statusRow.status, {
        activeEmbeddingSpace: activeSpace,
        embeddingSpace,
        chunkCount,
        embeddedChunkCount,
      });

      if (modeStatus === null) return null;

      return {
        fileId,
        fileHash: revisionRow.content_hash,
        indexedAt: Number(statusRow.updated_at ?? Date.now()),
        chunkCount,
        status: modeStatus,
        embeddingSpace,
      };
    } catch (error) {
      console.warn('[CanonicalModeIndexStatusAdapter] canonical status lookup failed for mode file', fileId, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  private resolveEmbeddingSpace(revisionId: string): string | null {
    const row = this.db.prepare(`
      SELECT s.provider, s.model, s.dimensions
      FROM rag_embeddings e
      JOIN rag_chunks c ON c.id = e.chunk_id
      JOIN rag_embedding_spaces s ON s.id = e.embedding_space_id
      WHERE c.revision_id = ?
      GROUP BY s.id, s.provider, s.model, s.dimensions
      ORDER BY MAX(e.created_at) DESC, s.id DESC
      LIMIT 1
    `).get(revisionId) as { provider: string; model: string; dimensions: number } | undefined;

    if (!row) return null;
    return embeddingSpaceKey({
      name: row.provider,
      model: row.model,
      dimensions: row.dimensions,
    });
  }

  private mapStatus(
    canonicalStatus: string,
    details: {
      activeEmbeddingSpace: string | null;
      embeddingSpace: string | null;
      chunkCount: number;
      embeddedChunkCount: number;
    },
  ): CanonicalModeStatus | null {
    const { activeEmbeddingSpace, embeddingSpace, chunkCount, embeddedChunkCount } = details;

    switch (canonicalStatus) {
      case 'NOT_INDEXED':
      case 'QUEUED':
        return 'pending';
      case 'EXTRACTING':
      case 'CHUNKING':
      case 'EMBEDDING':
        return 'indexing';
      case 'OCR_REQUIRED':
        return 'ocr_required';
      case 'LEXICAL_READY':
        if (chunkCount > 0 && embeddedChunkCount === 0) return 'lexical_only';
        return null;
      case 'FAILED':
        return 'failed';
      case 'READY': {
        if (embeddingSpace === null) return null;
        if (activeEmbeddingSpace && activeEmbeddingSpace !== embeddingSpace) return 'pending';
        return 'ready';
      }
      default:
        return null;
    }
  }
}
