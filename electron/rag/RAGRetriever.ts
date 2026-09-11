import { VectorStore, ScoredChunk } from './VectorStore';
import { EmbeddingPipeline } from './EmbeddingPipeline';
import { formatChunkForContext } from './SemanticChunker';
// Phase 3 (semantic-retrieval repair, 2026-08-13): minSimilarity resolved per
// embedding space (legacy 0.25 for every space until telemetry calibrates).
import { resolveMinSimilarity } from '../llm/semanticAdmissionGate';
import { evaluateRagRelevanceGate } from './RagRelevanceGate';
import type { EvidenceItem } from '../intelligence/context-os/evidencePack';
export interface RAGConversationTurn {
userMessage: string;
assistantAnswer?: string;
mode?: string;
timestamp?: number;
}
interface LocalRerankerLike {
rerank(query: string, passages: string[]): Promise<Array<{ index: number; score: number }> | null>;
}
function isLocalRerankEnabled(): boolean {
try {
const { isRagLocalRerankEnabled } = require('../intelligence/intelligenceFlags') as typeof import('../intelligence/intelligenceFlags');
return isRagLocalRerankEnabled();
} catch {
return false;
}
}
/**
* Query intent types for biasing retrieval strategy
* Detected via regex patterns, not LLM
*/
export type QueryIntent =
| 'decision_recall' // "What did we decide?"
| 'speaker_lookup' // "What did X say?"
| 'action_items' // "What are my action items?"
| 'summary' // "Summarize..."
| 'open_question'; // Default fallback
export interface RetrievalOptions {
meetingId?: string; // For meeting-scoped queries
/** Prior conversation turns used only to improve retrieval relevance. */
conversation?: readonly RAGConversationTurn[];
maxTokens?: number; // Context token budget (default: 1500)
topK?: number; // Final context count (default: 8)
candidatePoolSize?: number; // Candidates per retrieval arm before hybrid fusion (default: 100)
rerankCandidatePoolSize?: number; // Candidates sent to the local cross-encoder (default: candidatePoolSize)
/** When true, return the hybrid candidate pool without final top-K/token-budget selection. */
deferFinalSelection?: boolean;
allowRerank?: boolean; // Enable local BGE cross-encoder reranking when the feature flag is on
recencyWeight?: number; // 0-1, how much to weight recent (default: 0.3)
intent?: QueryIntent; // Override detected intent
}
export type RagRetrievalStatus = 'ok' | 'no_relevant_evidence';

export interface RagRetrievalResponse<T> {
status: RagRetrievalStatus;
results: T[];
confidence: number;
}


const RETRIEVAL_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could',
  'did', 'do', 'does', 'for', 'from', 'give', 'has', 'have', 'how', 'i', 'in',
  'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our', 'please', 'should', 'tell',
  'the', 'their', 'them', 'they', 'this', 'that', 'to', 'us', 'was', 'we',
  'were', 'what', 'when', 'where', 'which', 'who', 'why', 'would', 'you',
  'your', 'about', 'also', 'say', 'said', 'mention', 'mentioned', 'discuss',
  'discussed', 'decide', 'decided', 'decision', 'summarize', 'summary', 'recap',
  'overview', 'highlight', 'highlights', 'key', 'point', 'points', 'meeting',
  'call', 'action', 'actions', 'item', 'items', 'task', 'tasks', 'follow',
  'followup', 'follow-up', 'next', 'step', 'steps',
]);

function retrievalTokens(text: string): string[] {
  return String(text ?? '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? [];
}

function normalizedRetrievalTerms(query: string): string[] {
  const tokens = retrievalTokens(query);
  return [...new Set(tokens.filter((token) => token.length > 1 && !RETRIEVAL_STOP_WORDS.has(token)))];
}

function termMatchesToken(term: string, token: string): boolean {
  if (term === token) return true;
  // Reuse the existing deterministic answer-relevance idea without adding a
  // numeric threshold: longer words may match their inflected form by a stable
  // four-character stem. This prevents "decide"/"decided" and similar pairs
  // from becoming artificial no-evidence cases.
  return term.length >= 5 && token.length >= 5 && term.slice(0, 4) === token.slice(0, 4);
}

/**
 * Change 16 final retrieval decision. A candidate is evidence only when its
 * text has question-specific coverage, not merely because lexical/vector
 * admission returned a chunk. The strict-majority rule mirrors the existing
 * evidenceSufficiency answer-relevance selection semantics; no new numeric
 * confidence threshold is introduced here.
 *
 * Synthesis/summary queries intentionally keep the existing retrieval-score
 * admission behavior: for a summary request, any candidate that survives the
 * source-owned retrieval gate is potentially useful context.
 */
export function hasQuestionSpecificRelevance(
  query: string,
  chunks: readonly ScoredChunk[],
  intent: QueryIntent,
): boolean {
  if (!chunks.length) return false;
  if (intent === 'summary') return true;

  const terms = normalizedRetrievalTerms(query);
  if (!terms.length) return true;

  return chunks.some((chunk) => {
    const words = retrievalTokens(chunk.text);
    const uniqueWords = new Set(words);
    const covered = terms.filter((term) => [...uniqueWords].some((word) => termMatchesToken(term, word))).length;

    // For a one-term factual query the term itself must be present. For a
    // multi-term query, require strict-majority coverage. This is the same
    // coverage boundary already used by evidenceSufficiency.ts for answer
    // relevance, rather than a new arbitrary score cutoff.
    return terms.length === 1
      ? covered === 1
      : covered * 2 > terms.length;
  });
}

export interface RetrievedContext extends RagRetrievalResponse<ScoredChunk> {
// `chunks` remains as a compatibility alias for existing callers.
// `results` is the canonical Change 16 retrieval payload.
chunks: ScoredChunk[];
formattedContext: string;
totalTokens: number;
meetingIds: string[];
intent: QueryIntent; // Detected query intent for prompt hints
}
/**
* RAGRetriever - Orchestrates the retrieval pipeline
*
* Flow:
* 1. Embed user query
* 2. Retrieve candidate chunks from VectorStore
* 3. Re-rank by relevance + recency
* 4. Assemble context within token budget
*/
function gateRetrievedChunks(
  chunks: ScoredChunk[],
  query: string,
  intent: QueryIntent,
): ScoredChunk[] {
if (!chunks.length) return [];

// Change 16: reuse the canonical Change 15 sufficiency gate rather than
// inventing a second confidence threshold. The retrieval adapter deliberately
// uses an unknown property and synthesis mode because this layer only answers
// one question: did retrieval produce evidence strong enough to enter the
// grounded RAG context? Property/entity answerability is resolved later by the
// governed Context OS path.
const evidenceItems = chunks.map((chunk, index) => ({
  evidenceId: `rag-retrieval:${String(chunk.id ?? index)}`,
  sourceKind: 'meeting',
  sourceId: String(chunk.meetingId ?? ''),
  sourceOwner: 'application',
  authority: 'evidence',
  trustLevel: 'retrieved',
  text: String(chunk.text ?? ''),
  pointer: {
    meetingId: String(chunk.meetingId ?? ''),
    chunkId: String(chunk.id ?? index),
    speaker: typeof chunk.speaker === 'string' ? chunk.speaker : undefined,
    timestampMs: Number.isFinite(Number(chunk.startMs)) ? Number(chunk.startMs) : undefined,
  },
  retrievalScore: Number(chunk.similarity) || 0,
  rerankScore: Number((chunk as ScoredChunk & { rerankScore?: number }).rerankScore),
  supports: { property: 'unknown' },
  score: {
    vector: Number(chunk.similarity) || 0,
    rerank: Number((chunk as ScoredChunk & { rerankScore?: number }).rerankScore),
    final: Number(chunk.finalScore ?? chunk.similarity) || 0,
  },
  reasonIncluded: 'retrieval',
})) as unknown as EvidenceItem[];

const decision = evaluateRagRelevanceGate({
  items: evidenceItems,
  requestedProperty: 'unknown',
  isSynthesis: true,
});

if (!decision.passed) return [];
if (!hasQuestionSpecificRelevance(query, chunks, intent)) return [];
const usable = new Set(decision.usableEvidenceIds);
return chunks.filter((chunk, index) => usable.has(`rag-retrieval:${String(chunk.id ?? index)}`));
}

export class RAGRetriever {
private vectorStore: VectorStore;
private embeddingPipeline: EmbeddingPipeline;
constructor(vectorStore: VectorStore, embeddingPipeline: EmbeddingPipeline) {
this.vectorStore = vectorStore;
this.embeddingPipeline = embeddingPipeline;
}

private noRelevantEvidence(intent: QueryIntent): RetrievedContext {
return {
status: 'no_relevant_evidence',
results: [],
confidence: 0,
chunks: [],
formattedContext: '',
totalTokens: 0,
meetingIds: [],
intent,
};
}

private withRetrievedResults(
chunks: ScoredChunk[],
formattedContext: string,
totalTokens: number,
meetingIds: string[],
intent: QueryIntent,
confidence: number,
): RetrievedContext {
return {
status: chunks.length > 0 ? 'ok' : 'no_relevant_evidence',
results: chunks,
confidence: chunks.length > 0 ? confidence : 0,
chunks,
formattedContext,
totalTokens,
meetingIds,
intent,
};
}

/**
* Retrieve relevant context for a query
*/
async retrieve(
query: string,
options: RetrievalOptions = {}
): Promise<RetrievedContext> {
const {
meetingId,
maxTokens = 1500,
topK = 8,
candidatePoolSize = 100,
rerankCandidatePoolSize,
deferFinalSelection = false,
allowRerank = true,
recencyWeight = 0.3,
intent: overrideIntent
} = options;
const intent = overrideIntent || this.detectIntent(query);
const retrievalQuery = this.buildConversationAwareQuery(query, options.conversation);
const semanticQuery = retrievalQuery;
const poolSize = Math.max(topK, Math.min(1000, candidatePoolSize));
// Universal meeting retrieval: build independent lexical + semantic candidate
// sets, then fuse them before recency/context selection. This promotes the
// same hybrid contract used by document sources into the common retriever.
const lexicalPromise = this.vectorStore.searchLexical(query, {
meetingId,
limit: poolSize,
});
let queryEmbedding: number[] | null = null;
try {
queryEmbedding = await this.embeddingPipeline.getEmbeddingForQuery(semanticQuery);
} catch (error) {
console.warn('[RAGRetriever] Query embedding failed; using lexical-only retrieval:', error);
}
const lexical = await lexicalPromise;
let semantic: ScoredChunk[] = [];
if (queryEmbedding) {
const spaceKey = this.embeddingPipeline.getActiveSpaceKey();
try {
semantic = await this.vectorStore.searchSimilar(queryEmbedding, {
meetingId,
limit: poolSize,
minSimilarity: resolveMinSimilarity(spaceKey),
spaceKey,
});
} catch (error) {
console.warn('[RAGRetriever] Semantic search failed; using lexical-only retrieval:', error);
}
}
if (!lexical.length && !semantic.length) {
return this.noRelevantEvidence(intent);
}
const semanticById = new Map<string, ScoredChunk>();
for (const chunk of semantic) semanticById.set(String(chunk.id), chunk);
const lexicalById = new Map<string, (ScoredChunk & { lexicalScore: number; bm25Score: number })>();
for (const chunk of lexical) lexicalById.set(String(chunk.id), chunk);
const keys = new Set<string>([...semanticById.keys(), ...lexicalById.keys()]);
const fused = [...keys].map((key) => {
const semanticChunk = semanticById.get(key);
const lexicalChunk = lexicalById.get(key);
const hasSemantic = !!semanticChunk;
const hasLexical = !!lexicalChunk;
const semanticScore = semanticChunk?.similarity ?? 0;
const lexicalScore = lexicalChunk?.lexicalScore ?? 0;
const combinedScore = hasSemantic && hasLexical
? (0.6 * semanticScore + 0.4 * lexicalScore)
: (hasSemantic ? semanticScore : lexicalScore);
const base = semanticChunk ?? lexicalChunk!;
return {
...base,
similarity: combinedScore,
semanticScore,
lexicalScore,
bm25Score: lexicalChunk?.bm25Score,
};
});
// Hybrid candidate pool is deliberately bounded before recency weighting and
// context assembly. This keeps the LLM-facing set small without throwing away
// lexical-only or semantic-only hits that the other arm discovered.
fused.sort((a, b) => b.similarity - a.similarity);
let candidates: ScoredChunk[] = fused.slice(0, poolSize);
// Stage 3: local BGE cross-encoder reranking. The existing LocalReranker
// owns ONNX lifecycle/worker isolation; this layer only supplies the
// bounded hybrid candidate pool and preserves the baseline on failure.
if (allowRerank && isLocalRerankEnabled() && candidates.length > 1) {
try {
const { getLocalReranker } = require('./LocalReranker') as typeof import('./LocalReranker');
const reranker = getLocalReranker() as unknown as LocalRerankerLike;
const requestedPool = rerankCandidatePoolSize ?? poolSize;
const rerankPoolSize = Math.max(topK, Math.min(poolSize, Math.min(1000, requestedPool)));
const rerankPool = candidates.slice(0, rerankPoolSize);
const reranked: Array<ScoredChunk & { rerankScore?: number }> = [];
const batchSize = 6;
for (let start = 0; start < rerankPool.length; start += batchSize) {
const batch = rerankPool.slice(start, start + batchSize);
const scores = await reranker.rerank(semanticQuery, batch.map(chunk => chunk.text));
if (!scores || scores.length < batch.length) {
throw new Error('local reranker returned incomplete scores');
}
for (const item of scores) {
const localIndex = Number(item.index);
if (!Number.isInteger(localIndex) || localIndex < 0 || localIndex >= batch.length) continue;
reranked.push({
...batch[localIndex],
rerankScore: Number(item.score),
});
}
}
if (reranked.length === rerankPool.length) {
const byId = new Map(reranked.map(chunk => [String(chunk.id), chunk]));
candidates = candidates.map(chunk => byId.get(String(chunk.id)) ?? chunk);
candidates.sort((a, b) => {
const ar = Number((a as ScoredChunk & { rerankScore?: number }).rerankScore);
const br = Number((b as ScoredChunk & { rerankScore?: number }).rerankScore);
if (Number.isFinite(br) && Number.isFinite(ar) && br !== ar) return br - ar;
return b.similarity - a.similarity;
});
}
} catch (error) {
console.warn('[RAGRetriever] Local rerank failed; keeping hybrid retrieval order:', error);
}
}
if (deferFinalSelection) {
const candidateChunks = candidates as ScoredChunk[];
// Even the deferred candidate-pool contract must establish that there is
// question-specific evidence. RAGManager may rerank these candidates later,
// but it must never receive an already-admitted vague chunk as "evidence".
const gatedCandidates = gateRetrievedChunks(candidateChunks, query, intent);
return this.withRetrievedResults(
 gatedCandidates,
'',
0,
[...new Set(gatedCandidates.map(c => c.meetingId))],
intent,
Math.max(...gatedCandidates.map(c => Number(c.similarity) || 0), 0),
);
}
const now = Date.now();
const ranked = candidates.map(chunk => ({
...chunk,
finalScore: this.computeFinalScore(chunk, now, recencyWeight)
}));
ranked.sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0));
const selected: ScoredChunk[] = [];
let totalTokens = 0;
for (const chunk of ranked) {
if (totalTokens + chunk.tokenCount > maxTokens) {
if (selected.length >= topK / 2) break;
continue;
}
selected.push(chunk);
totalTokens += chunk.tokenCount;
if (selected.length >= topK) break;
}
selected.sort((a, b) => a.startMs - b.startMs);
const gatedSelected = gateRetrievedChunks(selected, query, intent);
const formattedContext = gatedSelected
.map(chunk => formatChunkForContext(chunk))
.join('\n\n');
return this.withRetrievedResults(
 gatedSelected,
formattedContext,
totalTokens,
[...new Set(selected.map(c => c.meetingId))],
intent,
Math.max(...selected.map(c => Number(c.finalScore) || 0), 0),
);
}
/**
* Build a bounded retrieval query from the current query plus recent conversation.
* The lexical arm keeps the current query unchanged; the semantic/reranker arms
* receive this enriched form so prior turns can resolve references without
* replacing the user's current question.
*/
private buildConversationAwareQuery(
query: string,
conversation?: readonly RAGConversationTurn[],
): string {
const current = String(query ?? '').trim();
if (!conversation?.length) return current;
const turns = conversation
.filter(turn => String(turn?.userMessage ?? '').trim())
.slice(-6);
if (!turns.length) return current;
const parts: string[] = [`CURRENT RETRIEVAL QUESTION:\n${current}`];
for (const turn of turns) {
const user = String(turn.userMessage ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
const answer = String(turn.assistantAnswer ?? '').replace(/\s+/g, ' ').trim().slice(0, 700);
if (!user) continue;
parts.push(`PREVIOUS TURN:\nUser: ${user}${answer ? `\nAssistant: ${answer}` : ''}`);
}
return parts.join('\n\n').slice(0, 5000);
}
/**
* Retrieve with summaries for global search
* Combines chunk search with meeting summary search
*/
async retrieveGlobal(
query: string,
options: RetrievalOptions = {}
): Promise<RetrievedContext> {
const {
maxTokens = 1500,
topK = 8,
recencyWeight = 0.3,
intent: overrideIntent
} = options;
// Detect query intent
const intent = overrideIntent || this.detectIntent(query);
const semanticQuery = this.buildConversationAwareQuery(query, options.conversation);
// Embed query
let queryEmbedding: number[];
try {
queryEmbedding = await this.embeddingPipeline.getEmbeddingForQuery(semanticQuery);
} catch (error) {
console.error('[RAGRetriever] Failed to embed query:', error);
return this.noRelevantEvidence(intent);
}
// Search both chunks and summaries
const spaceKey = this.embeddingPipeline.getActiveSpaceKey();
const chunkResults = await this.vectorStore.searchSimilar(queryEmbedding, {
limit: topK * 2,
minSimilarity: resolveMinSimilarity(spaceKey),
spaceKey
});
const summaryResults = await this.vectorStore.searchSummaries(queryEmbedding, 5, spaceKey);
// Get meeting IDs from top summaries
const relevantMeetingIds = new Set(summaryResults.map(s => s.meetingId));
// Boost chunks from meetings with matching summaries
const boostedChunks = chunkResults.map(chunk => ({
...chunk,
similarity: relevantMeetingIds.has(chunk.meetingId)
? chunk.similarity * 1.2 // 20% boost
: chunk.similarity
}));
// Re-rank
const now = Date.now();
const ranked = boostedChunks.map(chunk => ({
...chunk,
finalScore: this.computeFinalScore(chunk, now, recencyWeight)
}));
ranked.sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0));
// Select within budget
const selected: ScoredChunk[] = [];
let totalTokens = 0;
for (const chunk of ranked) {
if (totalTokens + chunk.tokenCount > maxTokens) {
if (selected.length >= topK / 2) break;
continue;
}
selected.push(chunk);
totalTokens += chunk.tokenCount;
if (selected.length >= topK) break;
}
const gatedSelected = gateRetrievedChunks(selected, query, intent);
selected.splice(0, selected.length, ...gatedSelected);

// Group by meeting for coherent output
const byMeeting = new Map<string, ScoredChunk[]>();
for (const chunk of selected) {
if (!byMeeting.has(chunk.meetingId)) {
byMeeting.set(chunk.meetingId, []);
}
byMeeting.get(chunk.meetingId)!.push(chunk);
}
// Format with meeting grouping
const contextParts: string[] = [];
for (const [meetingId, chunks] of byMeeting) {
// Sort chunks within meeting by timestamp
chunks.sort((a, b) => a.startMs - b.startMs);
const chunkTexts = chunks.map(c => formatChunkForContext(c)).join('\n');
contextParts.push(`--- Meeting ${meetingId} ---\n${chunkTexts}`);
}
const formattedContext = contextParts.join('\n\n');
return this.withRetrievedResults(
selected,
formattedContext,
totalTokens,
[...byMeeting.keys()],
intent,
Math.max(...selected.map(c => Number(c.finalScore) || 0), 0),
);
}
/**
* Compute final score combining relevance and recency
*/
private computeFinalScore(
chunk: ScoredChunk,
now: number,
recencyWeight: number
): number {
// Recency: decay over 7 days (half-life)
const ageMs = now - chunk.startMs;
const ageHours = ageMs / (1000 * 60 * 60);
const recencyScore = Math.exp(-ageHours / 168); // 168 hours = 7 days
// Combined score
const relevanceWeight = 1 - recencyWeight;
const rerankScore = Number((chunk as ScoredChunk & { rerankScore?: number }).rerankScore);
const relevanceScore = Number.isFinite(rerankScore) ? rerankScore : chunk.similarity;
// BGE logits are not on the same calibrated scale as cosine similarity.
// Normalize only their relative ordering for the recency blend.
const normalizedRelevance = Number.isFinite(rerankScore)
? 1 / (1 + Math.exp(-rerankScore))
: relevanceScore;
return (relevanceWeight * normalizedRelevance) + (recencyWeight * recencyScore);
}
/**
* Detect query intent for biasing retrieval strategy
* Uses regex patterns, not LLM - fast and deterministic
*/
detectIntent(query: string): QueryIntent {
const lower = query.toLowerCase();
// Decision patterns
if (/\b(decide|decision|agreed|conclusion|settled|determined|resolved)\b/.test(lower) ||
/what did we (decide|agree|conclude)/.test(lower) ||
/did we (decide|agree|settle)/.test(lower)) {
return 'decision_recall';
}
// Speaker lookup patterns
if (/\b(said|mentioned|told|asked|suggested|proposed|pointed out)\b/.test(lower) &&
/\b(he|she|they|\w+)\s+(said|mentioned|told|asked)/.test(lower)) {
return 'speaker_lookup';
}
if (/what did (\w+|he|she|they) say/.test(lower) ||
/who said/.test(lower)) {
return 'speaker_lookup';
}
// Action items patterns
if (/\b(action|task|todo|to-do|follow[- ]?up|next step|assigned|deadline)\b/.test(lower) ||
/what (are|were) (my|the|our) (action|task|todo)/.test(lower) ||
/what (do i|should i|need to) do/.test(lower)) {
return 'action_items';
}
// Summary patterns
if (/\b(summar|overview|recap|highlights?|key points?)\b/.test(lower) ||
/^(summarize|recap|give me a summary)/.test(lower)) {
return 'summary';
}
return 'open_question';
}
/**
* Detect if query is meeting-scoped or global
*/
detectScope(query: string, currentMeetingId?: string): 'meeting' | 'global' {
const lower = query.toLowerCase();
// Meeting-scoped patterns
const meetingPatterns = [
'this meeting',
'this call',
'just now',
'earlier',
'they said',
'he said',
'she said',
'did they',
'did he',
'did she',
'what did'
];
// Global patterns
const globalPatterns = [
'all meetings',
'any meeting',
'ever discuss',
'find',
'search',
'when did we',
'have we ever',
'last time'
];
// Check patterns
for (const pattern of meetingPatterns) {
if (lower.includes(pattern)) return 'meeting';
}
for (const pattern of globalPatterns) {
if (lower.includes(pattern)) return 'global';
}
// Default based on context
return currentMeetingId ? 'meeting' : 'global';
}
}
