/**
 * Change 33: BGE input/output sizes for RAGManager.search().
 *
 * When rerank is active: ~50–100 candidates into LocalReranker, top 5–15 out.
 * Default pool is 50, not always 100. Callers may pick any value in 50–100.
 * When rerank is off, keep the pre-Change-33 1–50 / default-100 retrieval cut
 * so Knowledge/OKF and flag-off paths do not shrink or inflate.
 */

export const CANONICAL_RERANK_POOL_MIN = 50;
export const CANONICAL_RERANK_POOL_MAX = 100;
export const CANONICAL_RERANK_POOL_DEFAULT = 50;
export const CANONICAL_RERANK_TOP_MAX = 15;
export const CANONICAL_RERANK_TOP_DEFAULT = 8;
const LEGACY_TOP_MAX = 50;
const LEGACY_POOL_DEFAULT = 100;
const POOL_HARD_MAX = 1000;

export interface CanonicalRerankLimitOptions {
  topK?: number;
  candidatePoolSize?: number;
  rerankCandidatePoolSize?: number;
  rerankActive?: boolean;
}

export interface CanonicalRerankLimits {
  topK: number;
  candidatePoolSize: number;
  rerankCandidatePoolSize: number;
}

function intOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.trunc(value as number) : fallback;
}

export function resolveCanonicalRerankLimits(
  options: CanonicalRerankLimitOptions = {},
): CanonicalRerankLimits {
  const rerankActive = options.rerankActive === true;
  const topMax = rerankActive ? CANONICAL_RERANK_TOP_MAX : LEGACY_TOP_MAX;
  const topK = Math.max(1, Math.min(topMax, intOr(options.topK, CANONICAL_RERANK_TOP_DEFAULT)));
  const requestedPool = Math.max(
    topK,
    Math.min(POOL_HARD_MAX, intOr(options.candidatePoolSize, rerankActive ? CANONICAL_RERANK_POOL_DEFAULT : LEGACY_POOL_DEFAULT)),
  );
  if (!rerankActive) {
    return { topK, candidatePoolSize: requestedPool, rerankCandidatePoolSize: requestedPool };
  }
  const rerankCandidatePoolSize = Math.max(
    CANONICAL_RERANK_POOL_MIN,
    Math.min(CANONICAL_RERANK_POOL_MAX, intOr(options.rerankCandidatePoolSize, requestedPool)),
  );
  return {
    topK,
    candidatePoolSize: Math.max(requestedPool, rerankCandidatePoolSize),
    rerankCandidatePoolSize,
  };
}
