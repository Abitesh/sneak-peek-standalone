export type RagRetrievalComparisonSourceType = 'meeting' | 'mode' | 'personal' | 'knowledge';

export type RagRetrievalComparisonClassification =
  | 'EXACT_RESULT_PARITY'
  | 'LOGICAL_RESULT_EQUIVALENCE'
  | 'RANKING_DIVERGENCE'
  | 'CANDIDATE_MISS'
  | 'DUPLICATE_LOGICAL_RESULT'
  | 'INVALID_CANONICAL_RESULT'
  | 'NOT_COMPARABLE';

export interface RagRetrievalComparisonFilter {
  sourceIdsPresent: boolean;
  scopeIdPresent: boolean;
  currentRevisionRequired: boolean;
  readyRequired: boolean;
}

export interface RagRetrievalComparisonCandidate {
  sourceType: string;
  sourceId: string;
  documentId?: string;
  revisionId?: string;
  chunkId?: string;
  chunkIndex?: number;
  contentHash?: string;
  sourceLocator?: string;
  pageStart?: number;
  pageEnd?: number;
  section?: string;
  heading?: string;
  /** Legacy source identity, when the source exposes it. */
  legacyChunkId?: string;
  rank: number;
  score?: number;
}

export interface RagRetrievalComparison {
  path: string;
  sourceType: RagRetrievalComparisonSourceType;
  legacyCount: number;
  canonicalCount: number;
  logicalOverlapCount: number;
  legacyOnlyCount: number;
  canonicalOnlyCount: number;
  duplicateLogicalLegacyCount: number;
  duplicateLogicalCanonicalCount: number;
  rankDifferences: number;
  classifications: RagRetrievalComparisonClassification[];
  filter: RagRetrievalComparisonFilter;
  durationMs: number;
}

export interface RagRetrievalComparisonOptions {
  path: string;
  sourceType: RagRetrievalComparisonSourceType;
  canonical: readonly RagRetrievalComparisonCandidate[];
  legacy: readonly RagRetrievalComparisonCandidate[];
  filter?: Partial<RagRetrievalComparisonFilter>;
}

export interface RagRetrievalComparisonResult {
  comparison: RagRetrievalComparison;
}
