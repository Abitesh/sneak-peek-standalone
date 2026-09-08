// electron/rag/RagQueryPlanner.ts
// Change 8 — explicit query-rewriting stage for unified RAG retrieval.
//
// The planner deliberately does NOT replace the user's question. It produces a
// retrieval-only query from the current question plus existing conversation
// state. The answer pipeline must continue to use originalQuery.

import {
    getConversationState,
    resolveAgainstSession,
} from '../context-intelligence/question/conversation-state-store';
import type { ConversationState } from '../context-intelligence/question/conversation-state';

export interface RagQueryPlan {
    originalQuery: string;
    retrievalQuery: string;
    wasRewritten: boolean;
    reason?: 'referent' | 'conversation_context';
}

function clean(text: string): string {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function stripReferentAnnotation(text: string): string {
    return clean(text).replace(/\s*\(referring to:\s*[^)]*\)\s*$/i, '').trim();
}

function isReferential(query: string): boolean {
    const q = clean(query);
    return /^(?:and\s+)?(?:how|why|when|where|what|who|which|can|could|would|does|did|is|are|was|were|tell|explain|expand|elaborate|go)\b/i.test(q)
        && /\b(?:it|this|that|those|they|them|also|then|so|more|further|change|changed|different|difference|why|how)\b/i.test(q);
}

function extractTopic(previousQuestion: string, referent?: string): string {
    if (referent) return clean(referent);

    const q = stripReferentAnnotation(previousQuestion).replace(/[?!.]+$/, '').trim();
    const patterns = [
        /^(?:what|who|which)\s+(?:was|is|are|were)\s+(?:the\s+)?(.+)$/i,
        /^(?:what|who|which)\s+(?:did|does|do)\s+.+?\s+(?:say|use|choose|decide)\s+(?:about|for|on)\s+(.+)$/i,
        /^(?:tell|explain|describe)\s+(?:me\s+)?(?:about|the)\s+(.+)$/i,
    ];
    for (const pattern of patterns) {
        const m = q.match(pattern);
        if (m?.[1]) return clean(m[1]);
    }
    return '';
}

function rewriteFollowUp(originalQuery: string, state: ConversationState, resolved: string): string {
    const base = stripReferentAnnotation(resolved);
    if (!state) return base || originalQuery;

    const topic = extractTopic(state.previousQuestion ?? '', undefined)
        || extractTopic(originalQuery, undefined);
    const referent = extractTopic(state.previousQuestion ?? '', undefined);

    // The most common conversational form: "And how did it change?". Prefer
    // the resolved referent when the existing resolver supplied one, otherwise
    // derive a subject from the previous question. This stays deterministic and
    // does not manufacture a topic when none is available.
    if (/^(?:and\s+)?how\s+did\s+(?:it|this|that)\s+change\b/i.test(originalQuery)) {
        const subject = referent || topic;
        if (subject) return `How did ${subject} change?`;
    }

    if (/^(?:and\s+)?(?:why|how)\b/i.test(originalQuery) && referent) {
        const verb = /^\s*(?:and\s+)?why\b/i.test(originalQuery) ? 'Why' : 'How';
        const tail = originalQuery.replace(/^\s*(?:and\s+)?(?:why|how)\s*/i, '').replace(/[?!.]+\s*$/, '').trim();
        return tail ? `${verb} ${tail} regarding ${referent}?` : `${verb} ${referent}?`;
    }

    // Existing resolver output is already a safe retrieval rewrite. Remove its
    // annotation because the annotation is metadata, not useful lexical content.
    if (base && base !== originalQuery) return base;
    return originalQuery;
}

export class RagQueryPlanner {
    /**
     * Plan a retrieval query from the current question and existing session state.
     * No state or an unresolved follow-up is always a safe pass-through.
     */
    plan(originalQuery: string, sessionId?: string): RagQueryPlan {
        const original = clean(originalQuery);
        if (!original || !sessionId) {
            return { originalQuery: original, retrievalQuery: original, wasRewritten: false };
        }

        try {
            const state = getConversationState(sessionId);
            if (!state) {
                return { originalQuery: original, retrievalQuery: original, wasRewritten: false };
            }

            const ref = resolveAgainstSession(sessionId, original);
            const resolved = clean(ref.resolved);
            const referentResolved = Boolean(ref.usedState && resolved && resolved !== original);

            if (!referentResolved && !isReferential(original)) {
                return { originalQuery: original, retrievalQuery: original, wasRewritten: false };
            }

            const retrievalQuery = rewriteFollowUp(original, state, resolved || original);
            if (!retrievalQuery || retrievalQuery === original) {
                return { originalQuery: original, retrievalQuery: original, wasRewritten: false };
            }

            return {
                originalQuery: original,
                retrievalQuery: retrievalQuery,
                wasRewritten: true,
                reason: referentResolved ? 'referent' : 'conversation_context',
            };
        } catch {
            // Query planning is an enhancement to retrieval, never a reason to
            // fail the underlying RAG request.
            return { originalQuery: original, retrievalQuery: original, wasRewritten: false };
        }
    }
}
