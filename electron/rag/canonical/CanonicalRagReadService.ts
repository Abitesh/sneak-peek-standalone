import type { RagSearchResult } from '../storage/RagStorageTypes';
import type { CanonicalRagStorage } from './CanonicalRagStorage';
import { toLegacyRagSearchResult } from './CanonicalRagReadAdapter';
import { fuseRanked } from '../../intelligence/RrfFusion';
import { isRagRrfFusionEnabled } from '../../intelligence/intelligenceFlags';

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
 * Canonical FTS+vector merge is union-by-chunk-id unless `ragRrfFusion` is on.
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
    const united = unionCanonicalHits(lexical, vector);
    if (!isRagRrfFusionEnabled()) return united;
    return mergeCanonicalHitsByRrf(lexical, vector, united);
  }
}

function unionCanonicalHits(lexical: RagSearchResult[], vector: RagSearchResult[]): RagSearchResult[] {
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

function rankedItems(results: RagSearchResult[]): Array<{ id: string; text: string }> {
  return results
    .filter((hit) => Boolean(hit.chunk?.id) && typeof hit.chunk?.text === 'string' && hit.chunk.text.trim())
    .map((hit) => ({ id: hit.chunk.id, text: hit.chunk.text }));
}

function mergeCanonicalHitsByRrf(
  lexical: RagSearchResult[],
  vector: RagSearchResult[],
  united: RagSearchResult[],
): RagSearchResult[] {
  const { fused } = fuseRanked([
    { source: 'lexical', items: rankedItems(lexical) },
    { source: 'vector', items: rankedItems(vector) },
  ]);
  if (fused.length === 0) return united;
  const byId = new Map(united.filter((hit) => hit.chunk?.id).map((hit) => [hit.chunk.id, hit]));
  const out: RagSearchResult[] = [];
  const seen = new Set<string>();
  for (const item of fused) {
    const hit = byId.get(item.id);
    if (!hit) continue;
    seen.add(item.id);
    out.push({ ...hit, rrfScore: item.rrfScore });
  }
  for (const hit of united) {
    if (!hit.chunk?.id || seen.has(hit.chunk.id)) continue;
    out.push(hit);
  }
  return out;
}
