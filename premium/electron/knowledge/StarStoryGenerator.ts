/**
 * StarStoryGenerator - Premium Implementation
 * 
 * Generates structured "STAR" (Situation, Task, Action, Result) stories from candidate experiences.
 * Used to enhance profile evidence with guided storytelling framework.
 */

export interface StarStory {
  situation: string;
  task: string;
  action: string;
  result: string;
  generation_mode: 'guided' | 'freeform' | 'extracted';
  source?: string;
  confidence?: number;
}

export interface ContextNode {
  id: string;
  category: string;
  content: string;
  tags: string[];
  source?: string;
  confidence?: number;
}

/**
 * Extract tags from story content
 */
function extractTags(content: string): string[] {
  const tags: string[] = [];
  
  if (!content) return tags;

  const lowerContent = content.toLowerCase();
  
  // Category tags
  if (lowerContent.includes('led') || lowerContent.includes('led team')) {
    tags.push('leadership');
  }
  if (lowerContent.includes('improved') || lowerContent.includes('optimized')) {
    tags.push('optimization');
  }
  if (lowerContent.includes('problem') || lowerContent.includes('solved')) {
    tags.push('problem-solving');
  }
  if (lowerContent.includes('designed') || lowerContent.includes('architected')) {
    tags.push('design');
  }

  return tags;
}

/**
 * Convert STAR stories to context nodes for retrieval
 * Folds generation_mode into free-text tags, not a typed field
 */
export function starStoriesToNodes(stories: StarStory[]): ContextNode[] {
  return stories.map((story) => ({
    id: `star_${Math.random().toString(36).substr(2, 9)}`,
    category: 'star_story',
    content: `${story.situation}. ${story.task}. ${story.action}. ${story.result}`,
    tags: extractTags(`${story.situation} ${story.action} ${story.result} [mode: ${story.generation_mode}]`),
    source: story.source,
    confidence: story.confidence || 0.8,
  }));
}

/**
 * Generate STAR stories from experience entries
 */
export function generateStarStories(experience: any[]): StarStory[] {
  if (!experience || !Array.isArray(experience)) {
    return [];
  }

  return experience
    .map((exp) => {
      // Try to extract STAR elements from experience text
      const content = exp.description || exp.title || '';
      const lowerContent = content.toLowerCase();

      // Heuristic extraction
      const hasProblem = lowerContent.includes('problem') || lowerContent.includes('challenge');
      const hasAction = lowerContent.includes('built') || lowerContent.includes('implemented');
      const hasResult = lowerContent.includes('result') || lowerContent.includes('achieved');

      if (hasProblem && hasAction && hasResult) {
        return {
          situation: `In my role at ${exp.company || 'company'}`,
          task: `I needed to address a key challenge`,
          action: content,
          result: `This improved our systems and capabilities`,
          generation_mode: 'extracted' as const,
          source: exp.company,
          confidence: 0.6,
        };
      }

      return null;
    })
    .filter((s): s is StarStory => s !== null);
}

export class StarStoryGenerator {
  /**
   * Generate and convert stories to nodes in one step
   */
  static generateForExperience(experiences: any[]): ContextNode[] {
    const stories = generateStarStories(experiences);
    return starStoriesToNodes(stories);
  }

  /**
   * Enrich a context node with STAR metadata
   */
  static enrichNode(node: ContextNode, story?: StarStory): ContextNode {
    if (!story) return node;

    return {
      ...node,
      content: `[STAR Story]: ${node.content}`,
      tags: [...node.tags, 'star_story', `mode:${story.generation_mode}`],
    };
  }
}

export default StarStoryGenerator;
