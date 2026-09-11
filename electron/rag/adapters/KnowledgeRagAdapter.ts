import type { RagDocument, RagSearchResult } from '../RAGManager';
import type { RagSourceAdapter, RagSourceAdapterContext } from './RagSourceAdapter';
import { KnowledgeManager } from '../../services/knowledge/KnowledgeManager';
import { queryOkfCards } from '../../services/knowledge/OkfRetriever';
import { classifyQuestion } from '../../services/knowledge/QuestionClassifier';
import type { KnowledgeCard } from '../../services/knowledge/types';
import { isOkfKnowledgePacksEnabled, isOkfHybridRetrievalEnabled } from '../../intelligence/intelligenceFlags';

/**
 * Change 20: OKF/Knowledge is a derived retrieval index over the same
 * reference files already owned by the document RAG stack. Keep generation,
 * verification, editing, and persistence in KnowledgeManager; this adapter
 * only translates verified card retrieval into the canonical RAG result shape.
 */
export class KnowledgeRagAdapter implements RagSourceAdapter {
  async retrieve(context: RagSourceAdapterContext): Promise<RagSearchResult[]> {
    if (!isOkfKnowledgePacksEnabled() || !isOkfHybridRetrievalEnabled()) return [];
    const { options, query, candidatePoolSize } = context;
    const modesManager = this.getModesManager();
    if (!modesManager) return [];

    const modeId = options.modeId ?? modesManager.getActiveModeInfo?.()?.id;
    if (!modeId) return [];

    const files = modesManager.getReferenceFiles(modeId) ?? [];
    if (!files.length) return [];

    const classification = classifyQuestion(query);
    const topN = Math.max(1, Math.min(50, candidatePoolSize));
    const knowledgeManager = KnowledgeManager.getInstance();
    const results: RagSearchResult[] = [];

    for (const file of files) {
      const fileId = String(file?.id ?? '');
      if (!fileId) continue;
      const pack = knowledgeManager.getPackForFile(fileId);
      if (!pack || pack.cards.length === 0) continue;

      const scored = queryOkfCards(pack, query, classification, {
        topN,
        fileId,
      });

      for (let index = 0; index < scored.length; index += 1) {
        const { card, score } = scored[index];
        if (!card || !String(card.body ?? '').trim()) continue;
        results.push(this.toCanonicalResult(card, score, file, modeId, index));
      }
    }

    return results;
  }

  private getModesManager(): any | null {
    try {
      const { ModesManager } = require('../../services/ModesManager');
      return ModesManager.getInstance();
    } catch (error) {
      console.warn('[KnowledgeRagAdapter] Mode source unavailable:', error);
      return null;
    }
  }

  private toCanonicalResult(
    card: KnowledgeCard,
    score: number,
    file: any,
    modeId: string,
    index: number,
  ): RagSearchResult {
    const documentId = String(file?.id ?? card.sourceId);
    const pageStart = card.sourcePages?.length ? Math.min(...card.sourcePages) : undefined;
    const pageEnd = card.sourcePages?.length ? Math.max(...card.sourcePages) : undefined;
    const section = card.sourceSections?.[0];
    const source: RagDocument = {
      id: documentId,
      sourceType: 'knowledge',
      name: String(file?.fileName ?? file?.file_name ?? documentId),
      metadata: {
        modeId,
        knowledgeSourceId: card.sourceId,
      },
    };

    return {
      chunk: {
        id: `${documentId}:okf:${card.id}`,
        documentId,
        text: `${card.title}\n${card.body}`,
        ...(pageStart !== undefined ? { pageStart } : {}),
        ...(pageEnd !== undefined ? { pageEnd } : {}),
        ...(section ? { section } : {}),
        ...(card.title ? { heading: card.title } : {}),
        chunkIndex: index,
        metadata: {
          sourceType: 'knowledge',
          okfCardId: card.id,
          okfPackId: card.packId,
          okfConceptId: card.conceptId,
          okfType: card.type,
          okfConfidence: card.confidence,
          okfApprovalStatus: card.approvalStatus,
          okfEntities: card.entities,
          okfTags: card.tags,
          okfSourceQuotes: card.sourceQuotes,
          okfRelatedCardIds: card.relatedCardIds,
          okfCard: card,
        },
      },
      score: Number.isFinite(score) ? score : 0,
      lexicalScore: Number.isFinite(score) ? score : undefined,
      source,
    };
  }
}
