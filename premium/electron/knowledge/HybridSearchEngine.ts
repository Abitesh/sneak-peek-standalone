/**
 * HybridSearchEngine - Premium Implementation
 * 
 * Provides semantic and lexical search capabilities for profile retrieval.
 * Handles ranking nodes by relevance using hybrid scoring (semantic + keyword).
 */

/**
 * Category configuration for context formatting
 * Maps knowledge node categories to XML tags for LLM context
 */
export const categoryConfig = {
  'identity': {
    tag: 'candidate_identity_fact',
    order: 1,
  },
  'experience': {
    tag: 'candidate_experience',
    order: 2,
  },
  'star_story': {
    tag: 'candidate_experience',
    order: 2,
    prefix: '[STAR Story]: ',
  },
  'skill': {
    tag: 'candidate_skill',
    order: 3,
  },
  'education': {
    tag: 'candidate_education',
    order: 4,
  },
  'project': {
    tag: 'candidate_project',
    order: 5,
  },
  'achievement': {
    tag: 'candidate_achievement',
    order: 6,
  },
  'target_job': {
    tag: 'target_job',
    order: 7,
  },
  'company_research': {
    tag: 'company_research',
    order: 8,
  },
};

/**
 * Hybrid search scoring: combines semantic similarity and keyword matching
 */
import { isSemanticAdmissionGateEnabled, resolveSemanticFloor } from '../../../electron/llm/semanticAdmissionGate';

export interface SearchNode {
  id: string;
  category: string;
  content: string;
  tags?: string[];
  confidence?: number;
  semanticScore?: number;
  keywordScore?: number;
  blendedScore?: number;
  boostSum?: number;
}

/**
 * Cosine similarity between two vectors (embeddings)
 * Returns 0-1 score where 1 is identical
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA || !vecB || vecA.length !== vecB.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}

/**
 * Extract category hints from question text
 * Used for semantic admission gating
 */
export function detectCategoryHints(question: string): string[] {
  if (!question) return [];

  const lowerQuestion = question.toLowerCase();
  const hints: string[] = [];

  // Experience keywords
  if (lowerQuestion.match(/\b(experience|expertise|worked|job|role|position|company|employer)\b/)) {
    hints.push('experience');
  }

  // Skill keywords
  if (lowerQuestion.match(/\b(skill|technology|tool|language|framework|library)\b/)) {
    hints.push('skill');
  }

  // Education keywords
  if (lowerQuestion.match(/\b(education|degree|school|university|college|graduated)\b/)) {
    hints.push('education');
  }

  // Project keywords
  if (lowerQuestion.match(/\b(project|built|created|developed|shipped|launched)\b/)) {
    hints.push('project');
  }

  // Identity/intro keywords
  if (lowerQuestion.match(/\b(name|yourself|background|introduce|bio|profile)\b/)) {
    hints.push('identity');
  }

  return hints;
}

/**
 * Get relevant nodes for a question using hybrid scoring
 * 
 * @param question - The user question
 * @param nodes - Available knowledge nodes
 * @param embeddings - Optional semantic embeddings for nodes
 * @param queryEmbedding - Optional semantic embedding for question
 * @returns Sorted array of relevant nodes
 */
export async function getRelevantNodes(
  question: string,
  nodes: any[],
  embeddingsOrResolver?: Map<string, number[]> | ((embeddingSpaceKey?: string) => Promise<number[] | number[] | null | undefined>),
  queryEmbeddingOrOptions?: number[] | { embeddingSpaceKey?: string; spaceKey?: string },
  maybeOptions?: { embeddingSpaceKey?: string; spaceKey?: string }
): Promise<SearchNode[]> {
  if (!nodes || nodes.length === 0) {
    return [];
  }

  const hints = detectCategoryHints(question);
  const lowerQuestion = question.toLowerCase();
  const resolvedOptions = {
    ...(queryEmbeddingOrOptions && typeof queryEmbeddingOrOptions === 'object' && !Array.isArray(queryEmbeddingOrOptions) ? queryEmbeddingOrOptions : {}),
    ...(maybeOptions || {}),
  };
  const spaceKey = resolvedOptions.embeddingSpaceKey ?? resolvedOptions.spaceKey ?? null;
  const gateEnabled = isSemanticAdmissionGateEnabled();
  const floor = resolveSemanticFloor(spaceKey);

  let queryEmbedding: number[] | undefined;
  if (typeof embeddingsOrResolver === 'function') {
    try {
      const result = await embeddingsOrResolver(spaceKey || undefined);
      if (Array.isArray(result)) queryEmbedding = result;
    } catch {
      queryEmbedding = undefined;
    }
  } else if (Array.isArray(queryEmbeddingOrOptions)) {
    queryEmbedding = queryEmbeddingOrOptions;
  }

  const embeddings = embeddingsOrResolver instanceof Map ? embeddingsOrResolver : undefined;

  const scored: SearchNode[] = nodes.map((node: any) => {
    let semanticScore = 0;
    let keywordScore = 0;
    const nodeContent = node.content || node.text_content || '';

    if (queryEmbedding && embeddings?.has(node.id)) {
      const nodeEmbedding = embeddings.get(node.id);
      if (nodeEmbedding) {
        semanticScore = cosineSimilarity(queryEmbedding, nodeEmbedding);
      }
    } else if (queryEmbedding && Array.isArray(node.embedding)) {
      semanticScore = cosineSimilarity(queryEmbedding, node.embedding as number[]);
    }

    const content = (nodeContent || '').toLowerCase();
    const words = content.split(/\s+/);
    const questionWords = lowerQuestion.split(/\s+/);
    let matches = 0;
    for (const word of questionWords) {
      if (word.length > 2 && words.includes(word)) {
        matches++;
      }
    }
    keywordScore = matches / Math.max(questionWords.length, 1);

    let hintBonus = 0;
    if (hints.includes(node.category)) {
      hintBonus = 0.2;
    }

    const durationBoost = typeof node.duration_months === 'number' && node.duration_months > 0 ? Math.min(0.1, node.duration_months / 240) : 0.1;
    const recencyBoost = node.end_date == null ? 0.1 : 0;
    const boostSum = Math.min(0.4, durationBoost + recencyBoost + keywordScore * 0.2 + hintBonus);
    const blendedScore = semanticScore * 0.6 + boostSum;

    return {
      id: node.id,
      category: node.category || 'unknown',
      content: nodeContent || '',
      tags: node.tags || [],
      confidence: node.confidence || 0.5,
      semanticScore,
      keywordScore,
      blendedScore,
      boostSum,
    };
  });

  const legacyThreshold = 0.55;
  const candidates = scored.map((n) => {
    const cosine = Number.isFinite(n.semanticScore) ? n.semanticScore : 0;
    const boostSum = Number.isFinite(n.boostSum) ? n.boostSum : 0;
    const admitted = gateEnabled && floor !== null
      ? cosine >= floor
      : n.blendedScore > legacyThreshold;
    return { cosine, boostSum, admitted };
  });

  const telemetryPayload = {
    spaceKey,
    enforced: Boolean(gateEnabled && floor !== null),
    floor: floor ?? null,
    candidateCount: scored.length,
    candidates: scored.map((n, index) => ({
      id: n.id,
      cosine: Number.isFinite(n.semanticScore) ? n.semanticScore : 0,
      boostSum: Number.isFinite(n.boostSum) ? n.boostSum : 0,
      admitted: candidates[index]?.admitted ?? false,
    })),
  };
  console.log('[SemanticAdmission] ' + JSON.stringify(telemetryPayload));

  const returned = scored.filter((n) => gateEnabled && floor !== null ? n.semanticScore >= floor : n.blendedScore > legacyThreshold)
    .sort((a, b) => b.blendedScore - a.blendedScore);
  return returned;
}

/**
 * Format context block from nodes for LLM prompting
 * Groups nodes by category and renders with appropriate XML tags
 */
export function formatContextBlock(nodes: SearchNode[]): string {
  if (!nodes || nodes.length === 0) {
    return '';
  }

  // Group by category
  const grouped: Map<string, SearchNode[]> = new Map();
  for (const node of nodes) {
    const category = node.category || 'unknown';
    if (!grouped.has(category)) {
      grouped.set(category, []);
    }
    grouped.get(category)!.push(node);
  }

  // Render by order
  const blocks: string[] = [];
  const sortedCategories = Array.from(grouped.entries()).sort(
    (a, b) => (categoryConfig[a[0]]?.order || 99) - (categoryConfig[b[0]]?.order || 99)
  );

  for (const [category, nodeList] of sortedCategories) {
    const config = categoryConfig[category] || { tag: 'unknown' };
    const tag = config.tag;
    const prefix = config.prefix || '';

    for (const node of nodeList) {
      const content = prefix ? `${prefix}${node.content}` : node.content;
      blocks.push(`<${tag}>${content}</${tag}>`);
    }
  }

  return blocks.join('\n');
}

export class HybridSearchEngine {
  private nodes: SearchNode[] = [];
  private embeddings: Map<string, number[]> = new Map();

  /**
   * Index nodes for searching
   */
  indexNodes(nodes: any[], embeddings?: Map<string, number[]>): void {
    this.nodes = nodes.map((n) => ({
      id: n.id,
      category: n.category || 'unknown',
      content: n.content || '',
      tags: n.tags || [],
      confidence: n.confidence || 0.5,
    }));
    if (embeddings) {
      this.embeddings = embeddings;
    }
  }

  /**
   * Search for relevant nodes
   */
  search(question: string, embedding?: number[]): SearchNode[] {
    return getRelevantNodes(question, this.nodes, this.embeddings, embedding);
  }

  /**
   * Format search results for LLM context
   */
  formatResults(results: SearchNode[]): string {
    return formatContextBlock(results);
  }
}

export default HybridSearchEngine;
