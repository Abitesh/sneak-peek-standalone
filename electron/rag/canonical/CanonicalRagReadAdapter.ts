import type { CanonicalRagLexicalSearchResult } from './CanonicalRagQueryTypes';
import type { RagChunk, RagDocument, RagSearchResult } from '../storage/RagStorageTypes';

/**
 * Phase 8 read-contract preparation.
 *
 * This adapter converts canonical storage records into the existing public
 * RagSearchResult shape. It deliberately does not claim score-semantic parity
 * with the legacy hybrid pipeline. The canonical lexical score is preserved
 * as-is in `score` and `lexicalScore`; callers must not treat this adapter as
 * an authority switch until the retrieval/rerank/gate compatibility work is
 * proven.
 */
export function toLegacyRagSearchResult(
  result: CanonicalRagLexicalSearchResult,
): RagSearchResult {
  const score = Number(result.score);
  if (!Number.isFinite(score)) {
    throw new Error('Canonical RAG score must be finite');
  }

  const chunk: RagChunk = {
    id: result.chunk.id,
    documentId: result.document.sourceId,
    text: result.chunk.text,
    ...(result.chunk.pageStart !== null ? { pageStart: result.chunk.pageStart } : {}),
    ...(result.chunk.pageEnd !== null ? { pageEnd: result.chunk.pageEnd } : {}),
    ...(result.chunk.section !== null ? { section: result.chunk.section } : {}),
    ...(result.chunk.heading !== null ? { heading: result.chunk.heading } : {}),
    chunkIndex: result.chunk.chunkIndex,
    ...(result.chunk.startChar !== null ? { startOffset: result.chunk.startChar } : {}),
    ...(result.chunk.endChar !== null ? { endOffset: result.chunk.endChar } : {}),
    ...(result.chunk.speaker !== null ? { speaker: result.chunk.speaker } : {}),
    ...(result.chunk.timestampStart !== null ? { timestampStart: result.chunk.timestampStart } : {}),
    ...(result.chunk.timestampEnd !== null ? { timestampEnd: result.chunk.timestampEnd } : {}),
    metadata: {
      ...result.chunk.metadata,
      canonicalDocumentId: result.document.id,
      canonicalRevisionId: result.chunk.revisionId,
      canonicalContentHash: result.chunk.contentHash,
      ...(result.chunk.contentType !== null ? { contentType: result.chunk.contentType } : {}),
      ...(result.chunk.tokenCount !== null ? { tokenCount: result.chunk.tokenCount } : {}),
      ...(result.chunk.tableIndex !== null ? { tableIndex: result.chunk.tableIndex } : {}),
      ...(result.chunk.sourceLocator !== null ? { sourceLocator: result.chunk.sourceLocator } : {}),
    },
  };

  const source: RagDocument = {
    id: result.document.sourceId,
    sourceType: normalizeSourceType(result.document.sourceType),
    name: result.document.name,
    ...(result.document.path !== null ? { path: result.document.path } : {}),
    ...(result.document.mimeType !== null ? { mimeType: result.document.mimeType } : {}),
    metadata: {
      ...result.document.metadata,
      canonicalDocumentId: result.document.id,
      canonicalSourceId: result.document.sourceId,
      ...(result.document.scopeId !== null ? { canonicalScopeId: result.document.scopeId } : {}),
      ...(result.document.ownerId !== null ? { canonicalOwnerId: result.document.ownerId } : {}),
      ...(result.document.fileType !== null ? { fileType: result.document.fileType } : {}),
      ...(result.document.contentHash !== null ? { contentHash: result.document.contentHash } : {}),
    },
  };

  return {
    chunk,
    score,
    lexicalScore: score,
    source,
  };
}

function normalizeSourceType(sourceType: string): RagDocument['sourceType'] {
  switch (sourceType) {
    case 'meeting':
    case 'mode':
    case 'personal':
    case 'knowledge':
      return sourceType;
    default:
      throw new Error(`Unsupported canonical RAG source type: ${sourceType}`);
  }
}
