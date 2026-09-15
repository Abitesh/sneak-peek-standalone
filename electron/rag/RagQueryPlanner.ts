// electron/rag/RagQueryPlanner.ts
// Change 10  explicit source-selection stage for unified RAG.
//
// The planner keeps three concerns separate:
// 1. originalQuery  the user's actual question
// 2. retrievalQuery  the query used to find evidence
// 3. sources  which RAG source families should be searched / consulted
//
// Source selection is deterministic and conservative. It is a routing hint, not
// an authorization layer. Context Intelligence source policies and retrieval ports
// remain responsible for authorization on their own surfaces.

import {
 getConversationState,
 resolveAgainstSession,
} from '../context-intelligence/question/conversation-state-store';
import type { ConversationState } from '../context-intelligence/question/conversation-state';

export type RagSourceSelection =
 | 'mode-reference'
 | 'personal-files'
 | 'meeting'
 | 'conversation'
 | 'knowledge';

export interface RagQueryPlanningContext {
 /** Whether the active mode has reference files available to search. */
 hasModeReferenceFiles?: boolean;
 /** Whether Personal Files are available to search. */
 hasPersonalFiles?: boolean;
 /** Whether a meeting scope is active/available for transcript retrieval. */
 hasMeeting?: boolean;
}

export type RagRetrievalMode = 'skip' | 'retrieve';

export interface RagQueryPlan {
 originalQuery: string;
 retrievalQuery: string;
 sources: RagSourceSelection[];
 wasRewritten: boolean;
 reason?: 'referent' | 'conversation_context';
 sourceReason?: 'meeting' | 'personal' | 'mode' | 'follow_up' | 'conversation' | 'default';
 /** False when the prompt does not need document/meeting evidence (Change 29). */
 needsDocumentEvidence: boolean;
 retrievalMode: RagRetrievalMode;
}

function clean(text: string): string {
 return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function stripReferentAnnotation(text: string): string {
 return clean(text).replace(/\s*\(referring to:\s*[^)]*\)\s*$/i, '').trim();
}

function isFollowUpStub(query: string): boolean {
 const q = clean(query);
 return /^(?:please\s+)?(?:elaborate|continue|expand|go (?:on|deeper)|tell me more|more detail)\b/i.test(q);
}

function isReferential(query: string): boolean {
 const q = clean(query);
 if (isFollowUpStub(q)) return true;
 return /^(?:and\s+)?(?:how|why|when|where|what|who|which|can|could|would|does|did|is|are|was|were|tell|explain|expand|elaborate|go)\b/i.test(q)
 && /\b(?:it|this|that|those|they|them|also|then|so|more|further|change|changed|different|difference|why|how|elaborate|continue|deeper)\b/i.test(q);
}

function isConversationOnly(query: string): boolean {
 const q = clean(query);
 return /^(?:what did we|what have we|what were we|what was discussed|what did i say|what did you say|what did they say|what happened|what did we discuss|what was our discussion|what did we decide)\b/i.test(q)
 || /\b(?:five minutes ago|a few minutes ago|just now|earlier today|earlier|previously|in our meeting|in the meeting|on the call|during the call)\b/i.test(q);
}

function isMeetingQuery(query: string): boolean {
 const q = clean(query);
 return /\b(?:meeting|meetings|call|conversation|discuss(?:ed|ion)?|talk(?:ed|ing)?|said|mentioned|decided|decision|agreed|action items?|follow[- ]?up|next steps?|speaker|transcript)\b/i.test(q)
 || /\bwhat did (?:we|he|she|they|[a-z][a-z0-9_-]*) say\b/i.test(q);
}

function isPersonalQuery(query: string): boolean {
 const q = clean(query);
 return /\b(?:my|mine|personal|notes?|notebook|saved|resume|cv|curriculum vitae|my files?|personal files?|project notes?|find my)\b/i.test(q);
}

function isModeReferenceQuery(query: string): boolean {
 const q = clean(query);
 return /\b(?:annual report|quarterly report|report|reference file|reference files|uploaded document|uploaded file|document|documents|paper|specification|specs|policy|manual|handbook|presentation|slides|dataset|research|whitepaper)\b/i.test(q);
}

const DOCUMENT_SOURCES = new Set<RagSourceSelection>([
 'mode-reference',
 'personal-files',
 'meeting',
 'knowledge',
]);

function isGenerativeOrChitchat(query: string): boolean {
 const q = clean(query);
 if (!q) return true;
 if (/^(?:please\s+)?(?:write|draft|compose|create|make|generate|invent|brainstorm)\b/i.test(q)) return true;
 if (/^(?:tell me a joke|say something funny)\b/i.test(q)) return true;
 if (/^(?:hi|hello|hey|thanks|thank you|good (?:morning|afternoon|evening|night)|ok|okay)\b[.!?]*$/i.test(q)) return true;
 return false;
}

function planRetrievalNeed(
 query: string,
 sources: readonly RagSourceSelection[],
): { needsDocumentEvidence: boolean; retrievalMode: RagRetrievalMode; sources: RagSourceSelection[] } {
 if (isMeetingQuery(query) || isPersonalQuery(query) || isModeReferenceQuery(query)) {
  return { needsDocumentEvidence: true, retrievalMode: 'retrieve', sources: [...sources] };
 }
 if (isGenerativeOrChitchat(query)) {
  return { needsDocumentEvidence: false, retrievalMode: 'skip', sources: [] };
 }
 const needsDocumentEvidence = sources.some((source) => DOCUMENT_SOURCES.has(source));
 return {
  needsDocumentEvidence,
  retrievalMode: needsDocumentEvidence ? 'retrieve' : 'skip',
  sources: needsDocumentEvidence ? [...sources] : sources.filter((source) => source === 'conversation'),
 };
}

function inferPreviousSource(state: ConversationState | null): RagSourceSelection | null {
 if (!state) return null;
 const previous = clean(state.previousQuestion ?? '');
 if (!previous) return null;
 if (isMeetingQuery(previous)) return 'meeting';
 if (isPersonalQuery(previous)) return 'personal-files';
 if (isModeReferenceQuery(previous)) return 'mode-reference';
 return null;
}

function selectSources(
 query: string,
 state: ConversationState | null,
 context: RagQueryPlanningContext = {},
): { sources: RagSourceSelection[]; sourceReason: RagQueryPlan['sourceReason'] } {
 const q = clean(query);
 const referential = isReferential(q);
 const meeting = isMeetingQuery(q) || isConversationOnly(q);
 const personal = isPersonalQuery(q);
 const mode = isModeReferenceQuery(q);
 const previousSource = referential ? inferPreviousSource(state) : null;

 const sources: RagSourceSelection[] = [];

 // Explicit meeting/conversation questions should not fan out into unrelated
 // document pools. Conversation is a retrieval context source; meeting is the
 // actual transcript evidence source.
 if (meeting) {
 if (context.hasMeeting !== false) sources.push('meeting');
 sources.push('conversation');
 return { sources, sourceReason: 'meeting' };
 }

 // Personal-file questions are routed to My Files. Conversation is included only
 // when the wording is actually referential, so ordinary "find my notes" queries
 // don't unnecessarily inject prior chat turns into retrieval.
 if (personal) {
 if (context.hasPersonalFiles !== false) sources.push('personal-files');
 if (referential) sources.push('conversation');
 return { sources, sourceReason: 'personal' };
 }

 // Document/reference questions are routed to the active mode's reference files.
 if (mode) {
 if (context.hasModeReferenceFiles !== false) sources.push('mode-reference', 'knowledge');
 if (referential) sources.push('conversation');
 return { sources, sourceReason: 'mode' };
 }

 // A short follow-up inherits the source family of the previous question when
 // possible. Conversation is always included because it is what makes the
 // referent recoverable in the first place.
 if (previousSource) {
 sources.push(previousSource, 'conversation');
 return { sources: [...new Set(sources)], sourceReason: 'follow_up' };
 }

 if (referential) {
 sources.push('conversation');
 return { sources, sourceReason: 'conversation' };
 }

 // No reliable source signal: stay conservative rather than fan out across
// every document family. The caller can still explicitly request sources via
// RAGSearchOptions.selectedSources, and strong source signals are handled above.
return { sources: [], sourceReason: 'default' };
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

 if (/^(?:and\s+)?how\s+did\s+(?:it|this|that)\s+change\b/i.test(originalQuery)) {
 const subject = referent || topic;
 if (subject) return `How did ${subject} change?`;
 }

 if (/^(?:and\s+)?(?:why|how)\b/i.test(originalQuery) && referent) {
 const verb = /^\s*(?:and\s+)?why\b/i.test(originalQuery) ? 'Why' : 'How';
 const tail = originalQuery.replace(/^\s*(?:and\s+)?(?:why|how)\s*/i, '').replace(/[?!.]+\s*$/, '').trim();
 return tail ? `${verb} ${tail} regarding ${referent}?` : `${verb} ${referent}?`;
 }

 if (base && base !== originalQuery) return base;
 return originalQuery;
}

export class RagQueryPlanner {
 /**
 * Plan both retrieval wording and source families. Source selection is a routing
 * hint only; source authorization remains owned by the source-specific policies
 * and retrieval ports on the Context Intelligence path.
 */
 plan(
 originalQuery: string,
 sessionId?: string,
 context: RagQueryPlanningContext = {},
 ): RagQueryPlan {
 const original = clean(originalQuery);
 if (!original) {
 return {
 originalQuery: original,
 retrievalQuery: original,
 sources: [],
 wasRewritten: false,
 sourceReason: 'default',
 needsDocumentEvidence: false,
 retrievalMode: 'skip',
 };
 }

 let state: ConversationState | null = null;
 let retrievalQuery = original;
 let wasRewritten = false;
 let reason: RagQueryPlan['reason'];

 if (sessionId) {
 try {
 state = getConversationState(sessionId);
 if (state) {
 const ref = resolveAgainstSession(sessionId, original);
 const resolved = clean(ref.resolved);
 const referentResolved = Boolean(ref.usedState && resolved && resolved !== original);

 if (referentResolved || isReferential(original)) {
 const rewritten = rewriteFollowUp(original, state, resolved || original);
 if (rewritten && rewritten !== original) {
 retrievalQuery = rewritten;
 wasRewritten = true;
 reason = referentResolved ? 'referent' : 'conversation_context';
 }
 }
 }
 } catch {
 // Query planning is an enhancement to retrieval, never a reason to
 // fail the underlying RAG request.
 retrievalQuery = original;
 wasRewritten = false;
 reason = undefined;
 }
 }

 const selection = selectSources(original, state, context);
 const retrieval = planRetrievalNeed(original, selection.sources);
 return {
 originalQuery: original,
 retrievalQuery,
 sources: retrieval.sources,
 wasRewritten,
 ...(reason ? { reason } : {}),
 sourceReason: selection.sourceReason,
 needsDocumentEvidence: retrieval.needsDocumentEvidence,
 retrievalMode: retrieval.retrievalMode,
 };
 }
}

