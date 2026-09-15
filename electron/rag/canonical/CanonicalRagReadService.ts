import type { RagSearchResult } from '../storage/RagStorageTypes';
import type { CanonicalRagStorage } from './CanonicalRagStorage';
import { toLegacyRagSearchResult } from './CanonicalRagReadAdapter';

export interface CanonicalRagReadRequest {
  query: string;
  sourceType: 'meeting' | 'mode' | 'personal';
  sourceId?: string;
  scopeId?: string;
  limit: number;
  queryEmbedding?: readonly number[];
  embeddingSpaceId?: string;
  fallback: () => Promise<RagSearchResult[]>;
}

export interface CanonicalRagReadResult {
  results: RagSearchResult[];
  usedCanonical: boolean;
  fallbackReason: 'disabled' | 'empty' | 'error' | null;
}

/**
 * Production Phase 8 read-authority boundary.
 *
 * Canonical lexical storage is attempted first. Change 26 may add a vector
 * search in one embedding space when RAGManager supplies a query embedding.
 * An empty canonical result falls back to the existing source reader.
 * Vector failures keep lexical hits. The fallback is source-local.
 *
 * This class does not write, rank, gate, or mutate either backend.
 * // ponytail: union-by-chunk-id until Change 32 RRF
 */
export class CanonicalRagReadService {
  constructor(private readonly storage: CanonicalRagStorage) {}

  async readSource(request: CanonicalRagReadRequest): Promise<CanonicalRagReadResult> {
    const query = String(request.query ?? '').trim();
    if (!query) {
      return { results: [], usedCanonical: true, fallbackReason: null };
    }

    try {
      const limit = Math.max(1, Math.min(200, Number(request.limit) || 1));
      const lexicalResults = await this.storage.searchLexical(query, {
        sourceType: request.sourceType,
        sourceId: request.sourceId,
        scopeId: request.scopeId,
        limit,
      });
      let merged = this.mergeCanonicalHits(lexicalResults.map(toLegacyRagSearchResult), []);

      if (request.queryEmbedding && request.embeddingSpaceId) {
        try {
          const vectorResults = this.storage.searchVector(request.queryEmbedding, {
            embeddingSpaceId: request.embeddingSpaceId,
            sourceType: request.sourceType,
            sourceId: request.sourceId,
            scopeId: request.scopeId,
            limit,
          }).map((hit) => {
            const result = toLegacyRagSearchResult({
              chunk: hit.chunk,
              document: hit.document,
              score: -hit.distance,
            });
            return { ...result, semanticScore: -hit.distance };
          });
          merged = this.mergeCanonicalHits(merged, vectorResults);
        } catch (error) {
          console.warn(
            `[CanonicalRagRead] ${request.sourceType} canonical vector read failed; keeping lexical hits:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      if (merged.length > 0) {
        return {
          results: merged,
          usedCanonical: true,
          fallbackReason: null,
        };
      }

      const fallbackResults = await request.fallback();
      return {
        results: fallbackResults,
        usedCanonical: false,
        fallbackReason: 'empty',
      };
    } catch (error) {
      console.warn(
        `[CanonicalRagRead] ${request.sourceType} canonical read failed; falling back to legacy retrieval:`,
        error instanceof Error ? error.message : String(error),
      );
      const fallbackResults = await request.fallback();
      return {
        results: fallbackResults,
        usedCanonical: false,
        fallbackReason: 'error',
      };
    }
  }

  private mergeCanonicalHits(lexical: RagSearchResult[], vector: RagSearchResult[]): RagSearchResult[] {
    const byId = new Map<string, RagSearchResult>();
    for (const hit of lexical) byId.set(hit.chunk.id, hit);
    for (const hit of vector) {
      const existing = byId.get(hit.chunk.id);
      if (existing) {
        byId.set(hit.chunk.id, { ...existing, semanticScore: hit.semanticScore });
      } else {
        byId.set(hit.chunk.id, hit);
      }
    }
    return [...byId.values()];
  }
}
