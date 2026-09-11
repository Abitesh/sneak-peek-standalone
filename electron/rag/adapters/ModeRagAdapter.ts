import type { RagSearchResult, RagDocument } from '../RAGManager';
import type { RagSourceAdapter, RagSourceAdapterContext } from './RagSourceAdapter';

interface ModesManagerLike {
  getActiveModeInfo(): { id?: string } | null;
  getActiveMode(): any | null;
  getModes(): any[];
  getReferenceFiles(modeId: string): any[];
  retrieveHybridRaw(
    mode: any,
    files: any[],
    options: {
      query: string;
      topK?: number;
      tokenBudget?: number;
      allowRerank?: boolean;
      forceDocumentGrounding?: boolean;
    },
  ): Promise<any>;
}

/** Thin adapter around ModesManager's existing ModeHybridRetriever-backed path. */
export class ModeRagAdapter implements RagSourceAdapter {
  async retrieve(context: RagSourceAdapterContext): Promise<RagSearchResult[]> {
    const modesManager = this.getModesManager();
    if (!modesManager) return [];

    const { query, options, candidatePoolSize, tokenBudget } = context;
    const modeInfo = modesManager.getActiveModeInfo() ?? null;
    const modeId = options.modeId ?? modeInfo?.id;
    const activeMode = options.modeId
      ? (modesManager.getModes() ?? []).find((mode: any) => mode?.id === options.modeId) ?? null
      : modesManager.getActiveMode() ?? null;
    const files = modeId ? (modesManager.getReferenceFiles(modeId) ?? []) : [];
    if (!activeMode || !files.length) return [];

    const rawContext = await modesManager.retrieveHybridRaw(activeMode, files, {
      query,
      topK: candidatePoolSize,
      tokenBudget,
      allowRerank: false,
      ...(options.forceDocumentGrounding !== undefined
        ? { forceDocumentGrounding: options.forceDocumentGrounding }
        : {}),
    });

    const rawChunks = rawContext?.chunks ?? rawContext?.snippets ?? [];
    const fileById = new Map<string, any>(
      files.map((file: any) => [String(file?.id ?? ''), file]),
    );
    const results: RagSearchResult[] = [];

    for (const rawChunk of rawChunks) {
      const c = rawChunk as any;
      const documentId = String(c.sourceId ?? c.fileId ?? '');
      const text = String(c.text ?? '');
      if (!documentId || !text.trim()) continue;

      const file = fileById.get(documentId);
      const source = this.buildModeDocument(documentId, file, modeId);
      const pageRange = this.extractModePageRange(text);
      const heading = this.extractModeHeading(text);
      const section = this.extractModeSection(heading);
      const chunkIndex = Number(c.chunkIndex);
      const resolvedChunkIndex = Number.isFinite(chunkIndex) ? chunkIndex : 0;
      const score = Number(c.score);
      const semanticScore = Number(c.vectorScore);
      const lexicalScore = Number(c.ftsScore);
      const rerankScore = Number(c.rerankScore);

      results.push({
        chunk: {
          id: `${documentId}:${resolvedChunkIndex}`,
          documentId,
          text,
          ...(pageRange ? { pageStart: pageRange.start, pageEnd: pageRange.end } : {}),
          ...(section ? { section } : {}),
          ...(heading ? { heading } : {}),
          chunkIndex: resolvedChunkIndex,
          metadata: {
            trustLevel: c.trustLevel,
            embeddingSpace: c.embeddingSpace,
            ...(c.provenance && typeof c.provenance === 'object' ? c.provenance : {}),
            ...(c.metadata && typeof c.metadata === 'object' ? c.metadata : {}),
          },
        },
        score: Number.isFinite(score) ? score : 0,
        semanticScore: Number.isFinite(semanticScore) ? semanticScore : undefined,
        lexicalScore: Number.isFinite(lexicalScore) ? lexicalScore : undefined,
        rerankScore: Number.isFinite(rerankScore) ? rerankScore : undefined,
        source,
      });
    }
    return results;
  }

  private getModesManager(): ModesManagerLike | null {
    try {
      const { ModesManager } = require('../../services/ModesManager');
      return ModesManager.getInstance() as ModesManagerLike;
    } catch (error) {
      console.warn('[ModeRagAdapter] Mode source unavailable:', error);
      return null;
    }
  }

  private buildModeDocument(documentId: string, file: any, modeId?: string): RagDocument {
    return {
      id: documentId,
      sourceType: 'mode',
      name: String(file?.fileName ?? file?.file_name ?? documentId),
      metadata: {
        ...(modeId ? { modeId } : {}),
        ...(file?.pageCount !== undefined ? { pageCount: file.pageCount } : {}),
        ...(file?.extractedPageCount !== undefined ? { extractedPageCount: file.extractedPageCount } : {}),
      },
    };
  }

  private extractModePageRange(text: string): { start: number; end: number } | null {
    const matches = [...text.matchAll(/\[Page\s+(\d+)\]/gi)]
      .map((match) => Number(match[1]))
      .filter(Number.isFinite);
    if (matches.length === 0) return null;
    return { start: Math.min(...matches), end: Math.max(...matches) };
  }

  private extractModeHeading(text: string): string | undefined {
    const match = text.match(/^\s*(?:#{1,3}\s+|(?:\d+(?:\.\d+){0,2}\s+))([^\n]+)/m);
    return match?.[1]?.trim() || undefined;
  }

  private extractModeSection(heading?: string): string | undefined {
    if (!heading) return undefined;
    const match = heading.match(/^((?:\d+)(?:\.\d+){0,2})\s+/);
    return match?.[1];
  }
}
