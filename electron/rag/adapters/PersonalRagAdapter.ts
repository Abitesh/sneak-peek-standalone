import type Database from 'better-sqlite3';
import type { RagSearchResult, RagDocument } from '../RAGManager';
import type { RagSourceAdapter, RagSourceAdapterContext } from './RagSourceAdapter';
import type { EmbeddingPipeline } from '../EmbeddingPipeline';
import type { VectorStore } from '../VectorStore';

interface PersonalKnowledgeLike {
  searchRelevantAsync?(query: string, limit?: number): Promise<any[]>;
  searchRelevant?(query: string, limit?: number): any[];
  search?(query: string, limit?: number): any[];
  listFiles?(): any[];
  setEmbeddingServices?(embeddingPipeline: EmbeddingPipeline, vectorStore: VectorStore): void;
}

/** Thin adapter around PersonalKnowledgeManager's existing file retrieval. */
export class PersonalRagAdapter implements RagSourceAdapter {
  constructor(private readonly db: Database.Database) {}

  async retrieve(context: RagSourceAdapterContext): Promise<RagSearchResult[]> {
    const personalKnowledge = this.getPersonalKnowledge();
    if (!personalKnowledge) return [];

    const { query, candidatePoolSize } = context;
    const items = await (
      personalKnowledge.searchRelevantAsync?.(query, candidatePoolSize)
      ?? Promise.resolve(
        personalKnowledge.searchRelevant?.(query, candidatePoolSize)
        ?? personalKnowledge.search?.(query, candidatePoolSize)
        ?? [],
      )
    );

    const documentCache = new Map<string, RagDocument>();
    const results: RagSearchResult[] = [];
    for (const item of items ?? []) {
      const documentId = String(item.fileId ?? '');
      const text = String(item.text ?? '');
      const chunkId = String(item.chunkId ?? '');
      if (!documentId || !chunkId || !text.trim()) continue;

      let document = documentCache.get(documentId);
      if (!document) {
        document = this.buildPersonalDocument(documentId, item);
        documentCache.set(documentId, document);
      }

      const chunkMeta = this.getPersonalChunkMetadata(documentId, chunkId);
      const chunkIndex = Number(item.chunkIndex ?? chunkMeta?.chunkIndex);
      const startOffset = Number(item.startChar ?? chunkMeta?.startChar);
      const endOffset = Number(item.endChar ?? chunkMeta?.endChar);
      const score = Number(item.score);

      results.push({
        chunk: {
          id: chunkId,
          documentId,
          text,
          chunkIndex: Number.isFinite(chunkIndex) ? chunkIndex : 0,
          ...(Number.isFinite(startOffset) ? { startOffset } : {}),
          ...(Number.isFinite(endOffset) ? { endOffset } : {}),
          ...(item.pageStart !== undefined ? { pageStart: Number(item.pageStart) } : {}),
          ...(item.pageEnd !== undefined ? { pageEnd: Number(item.pageEnd) } : {}),
          ...(item.section ? { section: String(item.section) } : {}),
          ...(item.heading ? { heading: String(item.heading) } : {}),
          metadata: {
            sourceType: 'personal',
            contentType: item.contentType,
            ...(item.metadata && typeof item.metadata === 'object' ? item.metadata : {}),
            ...(item.embeddingSpace ? { embeddingSpace: item.embeddingSpace } : {}),
          },
        },
        score: Number.isFinite(score) ? score : 0,
        semanticScore: Number.isFinite(Number(item.semanticScore)) ? Number(item.semanticScore) : undefined,
        lexicalScore: Number.isFinite(Number(item.lexicalScore)) ? Number(item.lexicalScore) : undefined,
        source: document,
      });
    }
    return results;
  }

  private getPersonalKnowledge(): PersonalKnowledgeLike | null {
    try {
      const { getPersonalKnowledgeManager } = require('../../personalKnowledge');
      return getPersonalKnowledgeManager() as PersonalKnowledgeLike;
    } catch (error) {
      console.warn('[PersonalRagAdapter] Personal source unavailable:', error);
      return null;
    }
  }

  private buildPersonalDocument(documentId: string, item: any): RagDocument {
    const row = this.getPersonalDocumentMetadata(documentId);
    return {
      id: documentId,
      sourceType: 'personal',
      name: String(item.fileName ?? row?.file_name ?? documentId),
      ...(row?.file_path ? { path: String(row.file_path) } : {}),
      ...(row?.mime_type ? { mimeType: String(row.mime_type) } : {}),
      metadata: {
        fileType: row?.file_type,
        sizeBytes: row?.size_bytes,
        contentHash: row?.content_hash,
        createdAt: row?.created_at,
        updatedAt: row?.updated_at,
      },
    };
  }

  private getPersonalDocumentMetadata(documentId: string): any | null {
    try {
      return this.db.prepare(`
        SELECT id, file_name, file_path, mime_type, size_bytes, content_hash,
               created_at, updated_at, file_type
        FROM personal_files
        WHERE id = ?
        LIMIT 1
      `).get(documentId) ?? null;
    } catch (error) {
      console.warn('[PersonalRagAdapter] Failed to load personal document metadata:', error);
      return null;
    }
  }

  private getPersonalChunkMetadata(documentId: string, chunkId: string): any | null {
    try {
      return this.db.prepare(`
        SELECT chunk_index, start_char, end_char
        FROM personal_file_chunks
        WHERE id = ? AND file_id = ?
        LIMIT 1
      `).get(chunkId, documentId) ?? null;
    } catch (error) {
      console.warn('[PersonalRagAdapter] Failed to load personal chunk metadata:', error);
      return null;
    }
  }
}
