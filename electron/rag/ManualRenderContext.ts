// electron/rag/ManualRenderContext.ts
//
// Change 47Q — the renderer-facing representation of the already-selected
// universal RAG result set. This is deliberately separate from EvidencePack:
// EvidencePack governs answer evidence; this type only carries the minimum
// structured material needed to render manual document context.

import type { RagSearchResult, RagSourceType } from './storage/RagStorageTypes';

export interface ManualRenderItem {
  text: string;
  sourceId: string;
  documentId?: string;
  documentName?: string;
  chunkId?: string;
  pageStart?: number;
  pageEnd?: number;
  section?: string;
  heading?: string;
  sourceType?: RagSourceType;
}

export interface ManualRenderContext {
  /** Exactly the final selected RAG results, in their existing order. */
  items: ManualRenderItem[];
  /** Renderer intent only; retrieval policy remains outside this contract. */
  renderHints?: {
    broadQueryGrounding?: boolean;
  };
}

export function toManualRenderContext(
  results: readonly RagSearchResult[],
  renderHints?: ManualRenderContext['renderHints'],
): ManualRenderContext {
  return {
    items: results.map((result) => ({
      text: result.chunk.text,
      sourceId: String(result.source.id),
      ...(result.chunk.documentId ? { documentId: result.chunk.documentId } : {}),
      ...(result.source.name ? { documentName: result.source.name } : {}),
      ...(result.chunk.id ? { chunkId: result.chunk.id } : {}),
      ...(result.chunk.pageStart !== undefined ? { pageStart: result.chunk.pageStart } : {}),
      ...(result.chunk.pageEnd !== undefined ? { pageEnd: result.chunk.pageEnd } : {}),
      ...(result.chunk.section ? { section: result.chunk.section } : {}),
      ...(result.chunk.heading ? { heading: result.chunk.heading } : {}),
      ...(result.source.sourceType ? { sourceType: result.source.sourceType } : {}),
    })),
    ...(renderHints && Object.keys(renderHints).length ? { renderHints } : {}),
  };
}

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Render only the selected evidence. Retrieval never happens here.
 * The array order is the canonical presentation order.
 */
export function renderManualContext(context: ManualRenderContext): string {
  if (!context.items.length) return '';

  const body = context.items.map((item, index) => {
    const attrs = [
      `index="${index + 1}"`,
      `source_id="${escapeXml(item.sourceId)}"`,
      ...(item.documentId ? [`document_id="${escapeXml(item.documentId)}"`] : []),
      ...(item.documentName ? [`document_name="${escapeXml(item.documentName)}"`] : []),
      ...(item.chunkId ? [`chunk_id="${escapeXml(item.chunkId)}"`] : []),
      ...(item.sourceType ? [`source_type="${escapeXml(item.sourceType)}"`] : []),
      ...(item.pageStart !== undefined ? [`page_start="${item.pageStart}"`] : []),
      ...(item.pageEnd !== undefined ? [`page_end="${item.pageEnd}"`] : []),
      ...(item.section ? [`section="${escapeXml(item.section)}"`] : []),
      ...(item.heading ? [`heading="${escapeXml(item.heading)}"`] : []),
    ].join(' ');

    return [
      `  <evidence ${attrs}>`,
      `    <text>${escapeXml(item.text)}</text>`,
      '  </evidence>',
    ].join('\n');
  }).join('\n');

  const groundingHint = context.renderHints?.broadQueryGrounding
    ? '\n  <grounding mode="broad_document" />'
    : '';

  return `<manual_document_context>${groundingHint}\n${body}\n</manual_document_context>`;
}
