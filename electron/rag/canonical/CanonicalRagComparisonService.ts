import type {
  RagRetrievalComparison,
  RagRetrievalComparisonCandidate,
  RagRetrievalComparisonClassification,
  RagRetrievalComparisonOptions,
  RagRetrievalComparisonResult,
} from './CanonicalRagComparisonTypes';

/**
 * Compare retrieval outputs without making either system authoritative.
 *
 * The logical identity deliberately ignores canonical opaque document/chunk IDs.
 * When a migrated legacy chunk identity is available it is preferred; otherwise
 * source identity + chunk index + content hash form the comparison key.
 */
function logicalKey(candidate: RagRetrievalComparisonCandidate): string {
  const legacyChunkId = candidate.legacyChunkId ?? '';
  const chunkIndex = Number.isFinite(candidate.chunkIndex) ? String(candidate.chunkIndex) : '';
  const contentHash = candidate.contentHash ?? '';

  if (legacyChunkId) {
    return [candidate.sourceType, candidate.sourceId, 'legacy', legacyChunkId].join('\u001f');
  }

  if (chunkIndex || contentHash) {
    return [candidate.sourceType, candidate.sourceId, 'logical', chunkIndex, contentHash].join('\u001f');
  }

  // No fabricated equivalence: an opaque identity is only a fallback key for
  // diagnostics when the source supplied no stable logical provenance.
  return [candidate.sourceType, candidate.sourceId, 'opaque', candidate.chunkId ?? ''].join('\u001f');
}

function duplicateCount(candidates: readonly RagRetrievalComparisonCandidate[]): number {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = logicalKey(candidate);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let duplicates = 0;
  for (const count of counts.values()) {
    if (count > 1) duplicates += count - 1;
  }
  return duplicates;
}

function keySet(candidates: readonly RagRetrievalComparisonCandidate[]): Set<string> {
  return new Set(candidates.map(logicalKey));
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const key of left) if (right.has(key)) count += 1;
  return count;
}

function rankDifferences(
  legacy: readonly RagRetrievalComparisonCandidate[],
  canonical: readonly RagRetrievalComparisonCandidate[],
): number {
  const canonicalRanks = new Map<string, number>();
  for (const candidate of canonical) canonicalRanks.set(logicalKey(candidate), candidate.rank);

  let differences = 0;
  for (const candidate of legacy) {
    const canonicalRank = canonicalRanks.get(logicalKey(candidate));
    if (canonicalRank !== undefined && canonicalRank !== candidate.rank) differences += 1;
  }
  return differences;
}

export class CanonicalRagComparisonService {
  compare(options: RagRetrievalComparisonOptions): RagRetrievalComparisonResult {
    const startedAt = Date.now();
    const legacyKeys = keySet(options.legacy);
    const canonicalKeys = keySet(options.canonical);
    const logicalOverlapCount = intersectionSize(legacyKeys, canonicalKeys);
    const legacyOnlyCount = Math.max(0, legacyKeys.size - logicalOverlapCount);
    const canonicalOnlyCount = Math.max(0, canonicalKeys.size - logicalOverlapCount);
    const duplicateLogicalLegacyCount = duplicateCount(options.legacy);
    const duplicateLogicalCanonicalCount = duplicateCount(options.canonical);
    const rankDifferenceCount = rankDifferences(options.legacy, options.canonical);

    const classifications: RagRetrievalComparisonClassification[] = [];

    if (
      legacyKeys.size === canonicalKeys.size &&
      logicalOverlapCount === legacyKeys.size &&
      rankDifferenceCount === 0 &&
      duplicateLogicalLegacyCount === 0 &&
      duplicateLogicalCanonicalCount === 0
    ) {
      classifications.push('EXACT_RESULT_PARITY');
    } else {
      if (logicalOverlapCount > 0) {
        classifications.push(
          rankDifferenceCount > 0 ? 'RANKING_DIVERGENCE' : 'LOGICAL_RESULT_EQUIVALENCE',
        );
      }
      if (legacyOnlyCount > 0 || canonicalOnlyCount > 0) classifications.push('CANDIDATE_MISS');
      if (duplicateLogicalLegacyCount > 0 || duplicateLogicalCanonicalCount > 0) {
        classifications.push('DUPLICATE_LOGICAL_RESULT');
      }
    }

    if (options.sourceType === 'knowledge') {
      classifications.length = 0;
      classifications.push('NOT_COMPARABLE');
    } else if (classifications.length === 0) {
      classifications.push('NOT_COMPARABLE');
    }

    const comparison: RagRetrievalComparison = {
      path: options.path,
      sourceType: options.sourceType,
      legacyCount: options.legacy.length,
      canonicalCount: options.canonical.length,
      logicalOverlapCount,
      legacyOnlyCount,
      canonicalOnlyCount,
      duplicateLogicalLegacyCount,
      duplicateLogicalCanonicalCount,
      rankDifferences: rankDifferenceCount,
      classifications,
      filter: {
        sourceIdsPresent: options.filter?.sourceIdsPresent ?? false,
        scopeIdPresent: options.filter?.scopeIdPresent ?? false,
        currentRevisionRequired: options.filter?.currentRevisionRequired ?? true,
        readyRequired: options.filter?.readyRequired ?? true,
      },
      durationMs: Date.now() - startedAt,
    };

    return { comparison };
  }
}
