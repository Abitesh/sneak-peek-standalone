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

export function citationForEvidenceItem(item: {
  citation?: RagCitation;
  evidenceId: string;
  sourceId: string;
  documentId?: string;
  documentName?: string;
  chunkId?: string;
  pointer?: { chunkId?: string; section?: string; page?: number; fileId?: string };
  pageStart?: number;
  pageEnd?: number;
  section?: string;
  sourceType?: string;
  sourceKind?: string;
}): RagCitation {
  if (item.citation?.citationId) return item.citation;
  return buildStableRagCitation({
    documentId: item.documentId || item.pointer?.fileId || item.sourceId,
    documentName: item.documentName || item.pointer?.section || item.sourceId,
    chunkId: item.chunkId || item.pointer?.chunkId || item.evidenceId,
    pageStart: item.pageStart ?? item.pointer?.page,
    pageEnd: item.pageEnd,
    section: item.section,
    sourceType: item.sourceType || item.sourceKind || 'unknown',
  });
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Packed-evidence identity only. Never copies chunk/document text. */
export function citationMarkersForEvidenceItems(
  items: readonly {
    evidenceId: string;
    sourceId: string;
    citation?: RagCitation;
    documentId?: string;
    documentName?: string;
    documentTitle?: string;
    chunkId?: string;
    section?: string;
    page?: number;
    pageStart?: number;
    pageEnd?: number;
    sourceType?: string;
    metadata?: Record<string, unknown>;
  }[],
): Record<string, RagCitationMarker> {
  const citationMarkers: Record<string, RagCitationMarker> = {};
  const seenCitationIds = new Set<string>();
  for (const item of items) {
    const metadata = item.metadata ?? {};
    const citation = citationForEvidenceItem({
      citation: item.citation,
      evidenceId: item.evidenceId,
      sourceId: item.sourceId,
      documentId: item.documentId || item.sourceId,
      documentName: item.documentName || item.documentTitle || item.sourceId,
      chunkId: item.chunkId || item.evidenceId,
      pageStart: item.pageStart ?? item.page ?? finiteNumber(metadata.pageStart),
      pageEnd: item.pageEnd ?? finiteNumber(metadata.pageEnd),
      section: item.section ?? nonEmptyString(metadata.section),
      sourceType: item.sourceType,
    });
    const citationId = citation.citationId.trim();
    if (!citationId || seenCitationIds.has(citationId)) continue;
    seenCitationIds.add(citationId);
    const marker = `S${Object.keys(citationMarkers).length + 1}`;
    citationMarkers[marker] = {
      marker,
      evidenceId: item.evidenceId,
      citationId,
      citation,
    };
  }
  return citationMarkers;
}
