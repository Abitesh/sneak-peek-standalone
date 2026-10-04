// electron/intelligence/context-os/evidencePack.ts
//
// Context OS (Phase 1) — typed evidence. Every piece of retrieved material
// becomes an EvidenceItem with source kind, source id, authority, trust level
// and provenance pointer, so validators and the prompt renderer can reason
// about WHERE a fact came from instead of consuming an opaque string block.
//
// Distinct from the OKF-only `RetrievalEvidencePack`
// (electron/services/knowledge/RetrievalEvidencePack.ts): that one carries OKF
// retrieval tiers for the false-refusal repair gate. This EvidencePack is the
// cross-source, contract-scoped answer-time pack; Phase 4's orchestrator can
// wrap OKF results INTO EvidenceItems.
import type {
EvidenceAuthority,
RequestedProperty,
SourceKind,
SourceOwner,
TrustLevel,
} from './types';
import { deriveEvidenceSufficiency, type EvidenceSufficiency } from './evidenceSufficiency';
import type { RagCitation } from '../../rag/RagCitation';
import type { ContextSource } from '../engine/ContextTypes';
import type { NativelyEvidence } from '../engine/types';
export interface EvidencePointer {
page?: number;
section?: string;
timestampMs?: number;
cardId?: string;
chunkId?: string;
fileId?: string;
meetingId?: string;
claimId?: string;
speaker?: string;
}
export interface EvidenceItem {
evidenceId: string;
/** Canonical Natively Intelligence source selected by ContextPlanner. */
canonicalSource?: ContextSource;
/** Explicit retrieval scope preserved across the evidence boundary. */
scope?: { kind: string; id: string | null };
/** Normalized 0..1 relevance/confidence independent of retrieval implementation. */
relevance?: number;
confidence?: number;
/** Structured provenance retained for validators and later prompt assembly. */
provenance?: Record<string, unknown>;
/** Canonical RAG citation retained through EvidencePack and rendering. */
citation?: RagCitation;
/** Canonical RAG provenance retained through EvidencePack and rendering. */
sourceType?: 'meeting' | 'mode' | 'personal';
documentId?: string;
documentName?: string;
chunkId?: string;
sourceKind: SourceKind;
sourceId: string;
sourceOwner: SourceOwner;
authority: EvidenceAuthority;
trustLevel: TrustLevel | string;
text: string;
pointer?: EvidencePointer;
retrievalScore?: number;
rerankScore?: number;
pageStart?: number;
pageEnd?: number;
section?: string;
heading?: string;
supports: {
entity?: string;
property: RequestedProperty;
value?: string;
};
score: {
lexical?: number;
vector?: number;
rerank?: number;
propertyMatch?: number;
final: number;
};
reasonIncluded: string;
}
export type EvidenceRejectionReason =
| 'forbidden_source'
| 'referent_only'
| 'property_mismatch'
| 'low_confidence'
| 'wrong_entity'
| 'stale'
| 'unverified_memory';
export interface RejectedEvidenceItem {
sourceKind: SourceKind;
sourceId?: string;
/** Short preview only — never the full content (privacy-safe traces). */
textPreview?: string;
reason: EvidenceRejectionReason;
}
export type AnswerPolicy =
| 'answer'
| 'answer_with_uncertainty'
| 'refuse_insufficient_evidence'
| 'ask_clarification';
export interface EvidenceConflict {
leftEvidenceId: string;
rightEvidenceId: string;
conflictType: string;
resolution: string;
}
export interface EvidenceCoverage {
hasDirectEvidence: boolean;
propertySatisfied: boolean;
entityMatched: boolean;
sourceOwnerSatisfied: boolean;
confidence?: number;
}
export interface EvidenceSelection {
candidateEvidenceIds: string[];
selectedEvidenceIds: string[];
excludedEvidenceIds: string[];
strategy: 'smallest_sufficient_set';
}
export interface EvidenceResolverMetadata {
strategy: string;
attemptedSources: SourceKind[];
retrievedSources: SourceKind[];
}
/**
* RC9 (Phase 6 Slice 4, context-rebuild, 2026-07-25, target arch §5): WHY a
* pack's `items` is empty — distinguishes a genuine no-match from an
* embedding-provider outage or a policy-forbidden turn, none of which
* should be reported to the user identically ("I don't have that
* information" is honest for `no_match`, misleading for
* `embedding_provider_down`). Only meaningful when `items.length === 0`.
*/
export type ZeroEvidenceReason =
| 'no_match' // genuinely nothing scored above threshold
| 'embedding_provider_down' // RC9: distinguish outage from no-match
| 'not_permitted_by_policy' // CanonicalTurn/isLayerAllowed forbids every candidate source
| 'no_sources_configured'; // e.g. no résumé uploaded at all
export interface EvidencePack {
/**
* Stable identity for THIS pack instance (Phase 6/M4). The exact pack used for
* generation must be the exact pack used for post-generation validation —
* `packId` lets a validator assert it is checking the same evidence the answer
* was produced from, instead of a re-fetched block.
*
* MANDATORY as of Phase 6 Slice 4 (context-rebuild, 2026-07-25, item 5) —
* every real construction site was audited and already supplies it (via
* `emptyEvidencePack()` or the `${turnId}:pack:${n}` convention); one gap
* found and fixed during this audit (`ProfileEvidenceService.ts`'s second
* return path).
*/
packId: string;
/** Regeneration lineage: an expanded pack increments version + links parent. */
version?: number;
parentPackId?: string;
turnId: string;
/** Original user question. The LLM answers this, not the retrieval rewrite. */
originalQuery?: string;
/** Retrieval-only rewrite from RagQueryPlanner. */
retrievalQuery?: string;
sourceOwner: SourceOwner;
requestedProperty: RequestedProperty;
items: EvidenceItem[];
rejected: RejectedEvidenceItem[];
coverage: EvidenceCoverage;
sufficiency?: EvidenceSufficiency;
selection?: EvidenceSelection;
resolver?: EvidenceResolverMetadata;
conflicts: EvidenceConflict[];
answerPolicy: AnswerPolicy;
/** RC9 — see ZeroEvidenceReason above. Only meaningful when `items` is empty. */
zeroEvidenceReason?: ZeroEvidenceReason;
}
// ── Small pure helpers ───────────────────────────────────────────────────────
/** Only items that may actually be cited as fact. */
export function evidenceOnlyItems(pack: Pick<EvidencePack, 'items'>): EvidenceItem[] {
return pack.items.filter((i) => i.authority === 'evidence');
}
/** A privacy-safe preview for rejected-item traces (first 80 chars). */
export function previewText(text: string | undefined | null, max = 80): string {
return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
/**
 * Build the canonical evidence boundary from the Change 7 retrieval result.
 *
 * Retrieval is already decided by ContextPlanner/RetrievalCoordinator. This
 * function does not retrieve, rank, or expand queries. It only validates source
 * membership and converts returned material into the Context OS EvidencePack
 * contract so later prompt assembly consumes one representation.
 */
export function buildEvidencePackFromNativelyEvidence(input: {
  turnId: string;
  query: string;
  contextPlan: import('../engine/ContextTypes').ContextPlan;
  evidence: NativelyEvidence;
  answerPolicy?: AnswerPolicy;
  sourceOwner?: SourceOwner;
  requestedProperty?: RequestedProperty;
}): EvidencePack {
  const allowed = new Set([
    ...input.contextPlan.requiredSources,
    ...input.contextPlan.optionalSources,
  ]);
  const rejected: RejectedEvidenceItem[] = [];
  const items: EvidenceItem[] = [];

  const ownerForSource = (source: ContextSource): SourceOwner => {
    switch (source) {
      case 'profile':
      case 'personal_knowledge': return 'profile';
      case 'meeting_transcript': return 'transcript';
      case 'screen': return 'screen_context';
      case 'mode_documents':
      case 'my_files': return 'reference_files';
      case 'project_knowledge':
      case 'structured_knowledge': return 'mixed';
      case 'recent_conversation':
      case 'longer_conversation': return 'mixed';
      case 'rag': return 'meeting_rag';
      default: return 'unknown';
    }
  };

  const sourceKindFor = (source: ContextSource): SourceKind => {
    switch (source) {
      case 'profile': return 'profile_resume';
      case 'meeting_transcript': return 'live_transcript';
      case 'screen': return 'screen_context';
      case 'mode_documents':
      case 'my_files': return 'mode_reference_chunk';
      case 'personal_knowledge': return 'hindsight_memory';
      case 'project_knowledge':
      case 'structured_knowledge': return 'okf_document_card';
      case 'recent_conversation':
      case 'longer_conversation': return 'prior_assistant_message';
      case 'rag': return 'meeting_rag_chunk';
      case 'none': return 'system_instruction';
    }
  };

  for (const raw of input.evidence.items) {
    const source = raw.source;
    if (!allowed.has(source) || input.contextPlan.forbiddenSources.includes(source)) {
      rejected.push({
        sourceKind: sourceKindFor(source),
        sourceId: raw.id,
        textPreview: previewText(raw.content),
        reason: 'forbidden_source',
      });
      continue;
    }

    const metadata = raw.metadata ?? {};
    const relevance = clamp01(
      typeof metadata.relevance === 'number' ? metadata.relevance : raw.score ?? 0,
    );
    const confidence = clamp01(
      typeof metadata.confidence === 'number' ? metadata.confidence : relevance,
    );
    const sourceId = typeof metadata.sourceId === 'string' && metadata.sourceId
      ? metadata.sourceId
      : raw.id;
    const scopeId = typeof metadata.scopeId === 'string' ? metadata.scopeId : null;
    const authority = metadata.authority === 'referent_only'
      ? 'referent_only'
      : metadata.authority === 'instruction'
        ? 'instruction'
        : 'evidence';

    items.push({
      evidenceId: raw.id,
      canonicalSource: source,
      scope: { kind: source, id: scopeId },
      relevance,
      confidence,
      provenance: typeof metadata.provenance === 'object' && metadata.provenance !== null
        ? metadata.provenance as Record<string, unknown>
        : metadata,
      sourceKind: sourceKindFor(source),
      sourceId,
      sourceOwner: ownerForSource(source),
      authority,
      trustLevel: typeof metadata.trustLevel === 'string' ? metadata.trustLevel : 'user_uploaded',
      text: raw.content,
      pointer: typeof metadata.pointer === 'object' && metadata.pointer !== null
        ? metadata.pointer as EvidencePointer
        : undefined,
      documentId: typeof metadata.documentId === 'string' ? metadata.documentId : undefined,
      documentName: typeof metadata.documentName === 'string' ? metadata.documentName : undefined,
      chunkId: typeof metadata.chunkId === 'string' ? metadata.chunkId : undefined,
      pageStart: typeof metadata.pageStart === 'number' ? metadata.pageStart : undefined,
      pageEnd: typeof metadata.pageEnd === 'number' ? metadata.pageEnd : undefined,
      section: typeof metadata.section === 'string' ? metadata.section : undefined,
      heading: typeof metadata.heading === 'string' ? metadata.heading : undefined,
      citation: metadata.citation as RagCitation | undefined,
      retrievalScore: raw.score,
      supports: {
        entity: typeof metadata.entity === 'string' ? metadata.entity : undefined,
        property: (typeof metadata.requestedProperty === 'string'
          ? metadata.requestedProperty
          : input.requestedProperty ?? 'unknown') as RequestedProperty,
        value: typeof metadata.value === 'string' ? metadata.value : undefined,
      },
      score: {
        final: relevance,
        ...(typeof metadata.lexical === 'number' ? { lexical: metadata.lexical } : {}),
        ...(typeof metadata.vector === 'number' ? { vector: metadata.vector } : {}),
        ...(typeof metadata.rerank === 'number' ? { rerank: metadata.rerank } : {}),
      },
      reasonIncluded: typeof metadata.reasonIncluded === 'string'
        ? metadata.reasonIncluded
        : `Selected by ContextPlan for ${source}`,
    });
  }

  const owners = new Set(items.map((item) => item.sourceOwner));
  const sourceOwner = input.sourceOwner
    ?? (owners.size === 1 ? [...owners][0] : 'mixed');
  const confidence = items.length
    ? Math.max(...items.map((item) => item.confidence ?? item.score.final ?? 0))
    : 0;
  const pack: EvidencePack = {
    packId: `${input.turnId}:pack:1`,
    version: 1,
    turnId: input.turnId,
    originalQuery: input.query,
    retrievalQuery: input.query,
    sourceOwner,
    requestedProperty: input.requestedProperty ?? 'unknown',
    items,
    rejected,
    coverage: {
      hasDirectEvidence: items.some((item) => item.authority === 'evidence'),
      propertySatisfied: items.some((item) => item.authority === 'evidence'),
      entityMatched: items.length > 0,
      sourceOwnerSatisfied: rejected.length === 0,
      confidence,
    },
    resolver: {
      strategy: 'natively_retrieval_coordinator',
      attemptedSources: input.contextPlan.requiredSources.map(sourceKindFor),
      retrievedSources: [...new Set(items.map((item) => item.sourceKind))],
    },
    conflicts: [],
    answerPolicy: input.answerPolicy ?? (items.length ? 'answer' : 'answer_with_uncertainty'),
    ...(items.length === 0 ? { zeroEvidenceReason: input.contextPlan.retrievalRequired ? 'no_match' as const : 'no_sources_configured' as const } : {}),
  };

  pack.sufficiency = deriveEvidenceSufficiency({ pack });
  return pack;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** An empty pack for a turn whose answer policy is decided without retrieval. */
export function emptyEvidencePack(input: {
turnId: string;
sourceOwner: SourceOwner;
requestedProperty: RequestedProperty;
answerPolicy: AnswerPolicy;
}): EvidencePack {
return {
packId: `${input.turnId}:pack:1:empty`,
version: 1,
turnId: input.turnId,
sourceOwner: input.sourceOwner,
requestedProperty: input.requestedProperty,
items: [],
rejected: [],
coverage: {
hasDirectEvidence: false,
propertySatisfied: false,
entityMatched: false,
sourceOwnerSatisfied: false,
confidence: 0,
},
conflicts: [],
answerPolicy: input.answerPolicy,
};
}
