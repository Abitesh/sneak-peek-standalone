import { MIN_ANSWER_CONFIDENCE } from '../intelligence/context-os/evidenceSufficiency';
import { isSemanticAdmissionGateEnabled, resolveSemanticFloor } from '../llm/semanticAdmissionGate';

// Must match ModeHybridRetriever MIN_LEXICAL_SCORE (MIN_COMBINED_SCORE * FTS_WEIGHT).
const MODE_MIN_LEXICAL_SCORE = 0.15 * 0.4;

export interface CanonicalHitScores {
  score?: number;
  semanticScore?: number;
  lexicalScore?: number;
  rerankScore?: number;
}

/**
 * Change 34: a hit may enter the governed answer path only if existing
 * floors admit it. No new threshold. BGE-rescued hits (rerankScore set)
 * use MIN_ANSWER_CONFIDENCE on the sigmoid final score. Uncalibrated
 * vector hits still face semanticAdmissionGate when a floor exists.
 */
export function admitCanonicalRagHit(
  result: CanonicalHitScores,
  spaceKey?: string | null,
): boolean {
  const final = Number(result.score);
  if (!Number.isFinite(final) || final < MIN_ANSWER_CONFIDENCE) return false;
  if (Number.isFinite(Number(result.rerankScore))) return true;

  const vector = Number(result.semanticScore);
  if (!isSemanticAdmissionGateEnabled() || !Number.isFinite(vector)) return true;

  const floor = resolveSemanticFloor(spaceKey);
  if (floor == null || vector >= floor) return true;

  const lexical = Number(result.lexicalScore);
  return Number.isFinite(lexical) && lexical >= MODE_MIN_LEXICAL_SCORE;
}
