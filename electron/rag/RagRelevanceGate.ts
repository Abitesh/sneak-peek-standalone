// electron/rag/RagRelevanceGate.ts
//
// Change 15 — canonical post-retrieval relevance/confidence decision.
//
// This is intentionally a thin decision layer. It does NOT invent a second
// similarity/confidence threshold. Semantic admission remains owned by
// semanticAdmissionGate.ts, ModeHybridRetriever keeps its retrieval thresholds
// and ragConfidenceGate-driven rerank escalation, and the final evidence
// sufficiency floor remains owned by evidenceSufficiency.ts.
//
// The important boundary is: candidates have already been retrieved and, when
// enabled/allowed, reranked before this gate is evaluated. If the resulting
// evidence cannot satisfy the existing sufficiency contract, the caller gets a
// deterministic FAIL and must not dispatch a governed factual answer from it.
import type { EvidenceItem, EvidencePack } from '../intelligence/context-os/evidencePack';
import { deriveEvidenceSufficiency, type EvidenceSufficiency } from '../intelligence/context-os/evidenceSufficiency';
import type { RequestedProperty } from '../intelligence/context-os/types';
export type RagRelevanceGateReason =
| 'pass'
| 'no_candidates'
| 'property_missing'
| 'entity_missing'
| 'low_confidence'
| 'conflicting'
| 'resolver_unavailable';
export interface RagRetrievalConfidenceSignal {
topScore?: number;
secondScore?: number;
margin?: number;
clearedCount?: number;
candidateCount?: number;
queryTokenCount?: number;
usedFallback?: boolean;
isLowConfidence?: boolean;
reasons?: readonly string[];
}
export interface RagRelevanceGateInput {
items: EvidenceItem[];
requestedProperty: RequestedProperty;
targetEntities?: string[];
isSynthesis?: boolean;
/**
* Optional pre-rerank retrieval signal. It is retained for observability and
* context, but is deliberately NOT used as a second post-rerank threshold.
* A low pre-rerank signal may have caused the existing local reranker to run
* and must not veto a candidate that became sufficiently relevant afterward.
*/
retrievalConfidence?: RagRetrievalConfidenceSignal;
/** Existing conflict state, when the upstream resolver has one. */
conflicts?: EvidencePack['conflicts'];
/** Set when retrieval/resolution itself failed rather than merely finding no evidence. */
resolverUnavailable?: boolean;
}
export interface RagRelevanceGateDecision {
passed: boolean;
confidence: number;
reason: RagRelevanceGateReason;
usableEvidenceIds: string[];
sufficiency: EvidenceSufficiency;
retrievalWasLowConfidence: boolean;
}
/**
* Evaluate the candidates that are about to become governed EvidenceItems.
*
* `deriveEvidenceSufficiency()` is the single source of truth for the actual
* confidence/property/entity decision, including MIN_ANSWER_CONFIDENCE. This
* function only translates that result into the RAG PASS/FAIL contract.
*/
export function evaluateRagRelevanceGate(input: RagRelevanceGateInput): RagRelevanceGateDecision {
const factual = input.items.filter((item) => item.authority === 'evidence');
const retrievalWasLowConfidence = input.retrievalConfidence?.isLowConfidence === true;
const pack: Pick<EvidencePack, 'items' | 'requestedProperty' | 'coverage' | 'conflicts'> = {
items: factual,
requestedProperty: input.requestedProperty,
coverage: {
hasDirectEvidence: factual.length > 0,
propertySatisfied: false,
entityMatched: false,
sourceOwnerSatisfied: true,
confidence: 0,
},
conflicts: input.conflicts ?? [],
};
const sufficiency = deriveEvidenceSufficiency({
pack,
targetEntities: input.targetEntities,
isSynthesis: input.isSynthesis,
resolverUnavailable: input.resolverUnavailable === true,
});
if (sufficiency.answerable) {
return {
passed: true,
confidence: sufficiency.confidence,
reason: 'pass',
usableEvidenceIds: sufficiency.usableEvidenceIds,
sufficiency,
retrievalWasLowConfidence,
};
}
let reason: RagRelevanceGateReason;
if (factual.length === 0 && sufficiency.reason === 'property_missing') {
reason = 'no_candidates';
} else switch (sufficiency.reason) {
case 'entity_missing':
reason = 'entity_missing';
break;
case 'conflicting':
reason = 'conflicting';
break;
case 'low_confidence':
reason = 'low_confidence';
break;
case 'resolver_unavailable':
reason = 'resolver_unavailable';
break;
case 'property_missing':
default:
reason = 'property_missing';
break;
}
return {
passed: false,
confidence: sufficiency.confidence,
reason,
usableEvidenceIds: sufficiency.usableEvidenceIds,
sufficiency,
retrievalWasLowConfidence,
};
}
