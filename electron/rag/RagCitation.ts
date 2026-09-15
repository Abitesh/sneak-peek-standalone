// electron/rag/RagCitation.ts
//
// Canonical citation object for retrieved RAG evidence. The application owns
// this metadata; the LLM is only given the citationId to reference it.
export interface RagCitation {
citationId: string;
documentId: string;
documentName: string;
chunkId: string;
pageStart?: number;
pageEnd?: number;
section?: string;
sourceType: string;
}

/**
 * Application-owned mapping between the short marker shown to the LLM and the
 * canonical citation metadata created by the application. The model may emit
 * only `marker` (for example, [S1]); it must never manufacture the metadata.
 */
export interface RagCitationMarker {
marker: string;
evidenceId: string;
citationId: string;
citation: RagCitation;
}
export function buildRagCitation(input: {
citationId: string;
documentId: string;
documentName: string;
chunkId: string;
pageStart?: number;
pageEnd?: number;
section?: string;
sourceType: string;
}): RagCitation {
return {
citationId: input.citationId,
documentId: input.documentId,
documentName: input.documentName,
chunkId: input.chunkId,
...(input.pageStart !== undefined ? { pageStart: input.pageStart } : {}),
...(input.pageEnd !== undefined ? { pageEnd: input.pageEnd } : {}),
...(input.section !== undefined ? { section: input.section } : {}),
sourceType: input.sourceType,
};
}

function sanitizeCitationPart(value: string): string {
  return String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'unknown';
}

/** Stable across retrieval → evidence → prompt → IPC. Not turn-index based. */
export function stableRagCitationId(sourceType: string, documentId: string, chunkId: string): string {
  return `cite_${sanitizeCitationPart(sourceType)}_${sanitizeCitationPart(documentId)}_${sanitizeCitationPart(chunkId)}`;
}

export function buildStableRagCitation(input: {
  documentId: string;
  documentName: string;
  chunkId: string;
  sourceType: string;
  pageStart?: number;
  pageEnd?: number;
  section?: string;
}): RagCitation {
  return buildRagCitation({
    citationId: stableRagCitationId(input.sourceType, input.documentId, input.chunkId),
    documentId: input.documentId,
    documentName: input.documentName,
    chunkId: input.chunkId,
    pageStart: input.pageStart,
    pageEnd: input.pageEnd,
    section: input.section,
    sourceType: input.sourceType,
  });
}
