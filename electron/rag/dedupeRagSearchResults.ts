import type { RagSearchResult } from './storage/RagStorageTypes';

function chunkKey(hit: RagSearchResult): string | null {
  const id = hit.chunk?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function mergeScores(winner: RagSearchResult, other: RagSearchResult): RagSearchResult {
  return {
    ...winner,
    lexicalScore: winner.lexicalScore ?? other.lexicalScore,
    semanticScore: winner.semanticScore ?? other.semanticScore,
    rerankScore: winner.rerankScore ?? other.rerankScore,
  };
}

/**
 * Cross-source candidate collapse for RAGManager.search.
 * // ponytail: union-by-chunk-id until Change 32 RRF
 */
export function dedupeRagSearchResults(results: readonly RagSearchResult[]): RagSearchResult[] {
  const best = new Map<string, RagSearchResult>();
  for (const hit of results) {
    const key = chunkKey(hit);
    if (!key) continue;
    const existing = best.get(key);
    if (!existing) {
      best.set(key, hit);
      continue;
    }
    const winner = (hit.score ?? 0) > (existing.score ?? 0) ? hit : existing;
    const other = winner === hit ? existing : hit;
    best.set(key, mergeScores(winner, other));
  }

  const seen = new Set<string>();
  const out: RagSearchResult[] = [];
  for (const hit of results) {
    const key = chunkKey(hit);
    if (!key) {
      out.push(hit);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(best.get(key)!);
  }
  return out;
}
