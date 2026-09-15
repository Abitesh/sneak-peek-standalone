import { randomUUID } from 'crypto';
import { deriveEvidenceSufficiency } from '../intelligence/context-os/evidenceSufficiency';
import type { EvidenceItem, EvidencePack } from '../intelligence/context-os/evidencePack';
import type { RagSearchResult } from './storage/RagStorageTypes';
import type { RagRetrievalStatus } from './RAGRetriever';

export function toRagEvidenceItems(results: readonly RagSearchResult[]): EvidenceItem[] {
  return results.map((result, index) => ({
    evidenceId: `rag-manager:${String(result.chunk.id ?? index)}`,
    sourceKind: result.source.sourceType as EvidenceItem['sourceKind'],
    sourceId: result.source.id,
    sourceOwner: 'unknown' as const,
    authority: 'evidence' as const,
    trustLevel: 'retrieved',
    text: result.chunk.text,
    pointer: {
      chunkId: result.chunk.id,
      fileId: result.source.sourceType === 'personal' ? result.source.id : undefined,
      meetingId: result.source.sourceType === 'meeting' ? result.source.id : undefined,
      page: result.chunk.pageStart,
      section: result.chunk.section,
    },
    documentName: result.source.name,
    pageStart: result.chunk.pageStart ?? undefined,
    pageEnd: result.chunk.pageEnd ?? undefined,
    section: result.chunk.section,
    heading: result.chunk.heading,
    documentId: result.chunk.documentId,
    chunkId: result.chunk.id,
    sourceType: result.source.sourceType === 'meeting' || result.source.sourceType === 'mode' || result.source.sourceType === 'personal'
      ? result.source.sourceType
      : undefined,
    retrievalScore: result.score,
    rerankScore: result.rerankScore,
    supports: { property: 'unknown' as const },
    score: {
      lexical: result.lexicalScore,
      vector: result.semanticScore,
      rerank: result.rerankScore,
      final: result.score,
    },
    reasonIncluded: 'retrieval',
  }));
}

export function buildRagEvidencePack(input: {
  originalQuery: string;
  retrievalQuery: string;
  results: readonly RagSearchResult[];
  status: RagRetrievalStatus;
}): EvidencePack {
  const items = input.status === 'ok' ? toRagEvidenceItems(input.results) : [];
  const sufficiency = deriveEvidenceSufficiency({
    pack: {
      items,
      requestedProperty: 'unknown',
      coverage: {
        hasDirectEvidence: items.length > 0,
        propertySatisfied: false,
        entityMatched: false,
        sourceOwnerSatisfied: true,
        confidence: 0,
      },
      conflicts: [],
    },
    isSynthesis: true,
  });
  return {
    packId: `rag-search:pack:${randomUUID().slice(0, 8)}`,
    version: 1,
    turnId: 'rag-search',
    originalQuery: input.originalQuery,
    retrievalQuery: input.retrievalQuery,
    sourceOwner: 'unknown',
    requestedProperty: 'unknown',
    items,
    rejected: [],
    coverage: {
      hasDirectEvidence: items.length > 0,
      propertySatisfied: sufficiency.propertySatisfied,
      entityMatched: sufficiency.entitySatisfied,
      sourceOwnerSatisfied: true,
      confidence: sufficiency.confidence,
    },
    sufficiency,
    conflicts: [],
    answerPolicy: input.status === 'ok' && sufficiency.answerable ? 'answer' : 'refuse_insufficient_evidence',
    ...(items.length === 0 ? { zeroEvidenceReason: 'no_match' as const } : {}),
  };
}

export function toRagSearchResponse(input: {
  originalQuery: string;
  retrievalQuery: string;
  results: readonly RagSearchResult[];
  status: RagRetrievalStatus;
}): {
  status: RagRetrievalStatus;
  results: RagSearchResult[];
  confidence: number;
  originalQuery: string;
  retrievalQuery: string;
  pack: EvidencePack;
} {
  const results = [...input.results];
  const confidence = results.length ? Math.max(...results.map((result) => Number(result.score) || 0), 0) : 0;
  return {
    status: input.status,
    results,
    confidence,
    originalQuery: input.originalQuery,
    retrievalQuery: input.retrievalQuery,
    pack: buildRagEvidencePack(input),
  };
}
