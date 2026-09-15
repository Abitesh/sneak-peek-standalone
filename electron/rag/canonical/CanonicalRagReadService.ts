import type { RagSearchResult } from '../storage/RagStorageTypes';
import type { CanonicalRagStorage } from './CanonicalRagStorage';
import { toLegacyRagSearchResult } from './CanonicalRagReadAdapter';

export interface CanonicalRagReadRequest {
  query: string;
  sourceType: 'meeting' | 'mode' | 'personal';
  sourceId?: string;
  scopeId?: string;
  limit: number;
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
 * Canonical lexical storage is attempted first. An empty canonical result is
 * treated as incomplete migration coverage and falls back to the existing
 * source reader. Any canonical read/adapter failure also falls back. The
 * fallback is deliberately source-local so one unavailable canonical source
 * cannot suppress unrelated source families.
 *
 * This class does not write, embed, rank, gate, or mutate either backend.
 */
export class CanonicalRagReadService {
  constructor(private readonly storage: CanonicalRagStorage) {}

  async readSource(request: CanonicalRagReadRequest): Promise<CanonicalRagReadResult> {
    const query = String(request.query ?? '').trim();
    if (!query) {
      return { results: [], usedCanonical: true, fallbackReason: null };
    }

    try {
      const canonicalResults = await this.storage.searchLexical(query, {
        sourceType: request.sourceType,
        sourceId: request.sourceId,
        scopeId: request.scopeId,
        limit: Math.max(1, Math.min(200, Number(request.limit) || 1)),
      });

      if (canonicalResults.length > 0) {
        return {
          results: canonicalResults.map(toLegacyRagSearchResult),
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
}
