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
