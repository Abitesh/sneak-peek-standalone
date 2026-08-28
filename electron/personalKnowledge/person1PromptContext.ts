// electron/personalKnowledge/person1PromptContext.ts
//
// Single prompt-side entry point for Person 1.
// Call this only after the AnswerPlan/context route has been built. The caller
// decides whether the `reference_files` layer is allowed; this helper never
// bypasses that policy.

import type { AnswerPlan } from '../llm/AnswerPlanner';
import { isLayerAllowed } from '../llm/contextRoute';
import { getPersonalKnowledgeManager } from './index';

export function getPerson1FileContext(
    plan: AnswerPlan,
    question: string,
): string {
    if (!question?.trim()) return '';
    if (!isLayerAllowed(plan, 'reference_files')) return '';

    try {
        return getPersonalKnowledgeManager().buildPromptContext(question);
    } catch (error) {
        console.warn('[Person1] file-context retrieval failed:', error);
        return '';
    }
}
