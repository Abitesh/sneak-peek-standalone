import type { RAGSearchOptions, RagSearchResult } from '../RAGManager';
import type { RAGConversationTurn } from '../RAGRetriever';

/**
 * Change 18: source implementations remain specialized, but RAGManager owns
 * the application-facing retrieval contract. Adapters translate each source's
 * native result shape into the canonical RagSearchResult shape.
 */
export interface RagSourceAdapterContext {
  query: string;
  options: RAGSearchOptions;
  candidatePoolSize: number;
  tokenBudget?: number;
  conversation?: readonly RAGConversationTurn[];
}

export interface RagSourceAdapter {
  retrieve(context: RagSourceAdapterContext): Promise<RagSearchResult[]>;
}
