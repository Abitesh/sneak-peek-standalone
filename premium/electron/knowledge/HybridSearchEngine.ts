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
export interface SearchNode {
  id: string;
  category: string;
  content: string;
  tags?: string[];
  confidence?: number;
  semanticScore?: number;
  keywordScore?: number;
  blendedScore?: number;
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
  if (lowerQuestion.match(/\b(experience|worked|job|role|position|company|employer)\b/)) {
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
export function getRelevantNodes(
  question: string,
  nodes: any[],
  embeddings?: Map<string, number[]>,
  queryEmbedding?: number[]
): SearchNode[] {
  if (!nodes || nodes.length === 0) {
    return [];
  }

  const hints = detectCategoryHints(question);
  const lowerQuestion = question.toLowerCase();

  // Score each node
  const scored: SearchNode[] = nodes.map((node: any) => {
    let semanticScore = 0;
    let keywordScore = 0;

    // Semantic scoring
    if (queryEmbedding && embeddings?.has(node.id)) {
      const nodeEmbedding = embeddings.get(node.id);
      if (nodeEmbedding) {
        semanticScore = cosineSimilarity(queryEmbedding, nodeEmbedding);
      }
    }

    // Keyword scoring
    const content = (node.content || '').toLowerCase();
    const words = content.split(/\s+/);
    const questionWords = lowerQuestion.split(/\s+/);
    let matches = 0;
    for (const word of questionWords) {
      if (word.length > 2 && words.includes(word)) {
        matches++;
      }
    }
    keywordScore = matches / Math.max(questionWords.length, 1);

    // Hint bonus for category matches
    let hintBonus = 0;
    if (hints.includes(node.category)) {
      hintBonus = 0.2;
    }

    // Blended score (60% semantic, 40% keyword + hints)
    const blendedScore = semanticScore * 0.6 + (keywordScore + hintBonus) * 0.4;

    return {
      id: node.id,
      category: node.category || 'unknown',
      content: node.content || '',
      tags: node.tags || [],
      confidence: node.confidence || 0.5,
      semanticScore,
      keywordScore,
      blendedScore,
    };
  });

  // Sort by blended score (threshold: 0.55)
  const threshold = 0.55;
  return scored
    .filter((n) => n.blendedScore > threshold)
    .sort((a, b) => b.blendedScore - a.blendedScore);
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
