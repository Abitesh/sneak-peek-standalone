import { buildStableRagCitation } from './RagCitation';
import type { RagSearchResult } from './storage/RagStorageTypes';

export type RagDiagnosticHit = {
  chunkId: string;
  documentId: string;
  documentName: string;
  sourceType: string;
  score: number;
  pageStart?: number;
  pageEnd?: number;
  section?: string;
  citationId: string;
};

export type RagDiagnosticEvent = {
  originalQuery: string;
  retrievalQuery: string;
  status: string;
  skipped: boolean;
  sources: string[];
  hitCount: number;
  elapsedMs: number;
  confidence: number;
  citationIds: string[];
  hits: RagDiagnosticHit[];
};

export function isRagDiagnosticsEnabled(): boolean {
  const raw = String(process.env.NATIVELY_RAG_DIAGNOSTICS ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

export function buildRagDiagnosticEvent(input: {
  originalQuery: string;
  retrievalQuery: string;
  status: string;
  results?: readonly RagSearchResult[];
  confidence?: number;
  elapsedMs?: number;
  sources?: readonly string[];
  skipped?: boolean;
}): RagDiagnosticEvent {
  const results = input.results ?? [];
  const hits: RagDiagnosticHit[] = results.map((result, index) => {
    const documentId = result.chunk.documentId || result.source.id;
    const chunkId = result.chunk.id || `${documentId}:${index}`;
    const citation = buildStableRagCitation({
      documentId,
      documentName: result.source.name,
      chunkId,
      sourceType: result.source.sourceType,
      pageStart: result.chunk.pageStart,
      pageEnd: result.chunk.pageEnd,
      section: result.chunk.section,
    });
    return {
      chunkId,
      documentId,
      documentName: result.source.name,
      sourceType: result.source.sourceType,
      score: Number(result.score) || 0,
      citationId: citation.citationId,
      ...(result.chunk.pageStart !== undefined ? { pageStart: result.chunk.pageStart } : {}),
      ...(result.chunk.pageEnd !== undefined ? { pageEnd: result.chunk.pageEnd } : {}),
      ...(result.chunk.section ? { section: result.chunk.section } : {}),
    };
  });
  return {
    originalQuery: input.originalQuery,
    retrievalQuery: input.retrievalQuery,
    status: input.status,
    skipped: input.skipped === true,
    sources: [...(input.sources ?? [])],
    hitCount: hits.length,
    elapsedMs: Number(input.elapsedMs) || 0,
    confidence: Number(input.confidence) || 0,
    citationIds: hits.map((hit) => hit.citationId),
    hits,
  };
}

/** Change 39: observe retrieval without dumping chunk.text / document bodies. */
export function recordRagSearch(
  input: Parameters<typeof buildRagDiagnosticEvent>[0],
  log: (...args: unknown[]) => void = console.log,
): void {
  if (!isRagDiagnosticsEnabled()) return;
  log('[RagDiagnostics]', JSON.stringify(buildRagDiagnosticEvent(input)));
}
