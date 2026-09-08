import { VectorStore, ScoredChunk } from './VectorStore';
import { EmbeddingPipeline } from './EmbeddingPipeline';
import { formatChunkForContext } from './SemanticChunker';
// Phase 3 (semantic-retrieval repair, 2026-08-13): minSimilarity resolved per
// embedding space (legacy 0.25 for every space until telemetry calibrates).
import { resolveMinSimilarity } from '../llm/semanticAdmissionGate';

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
export interface RetrievedContext {
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
export class RAGRetriever {
private vectorStore: VectorStore;
private embeddingPipeline: EmbeddingPipeline;
constructor(vectorStore: VectorStore, embeddingPipeline: EmbeddingPipeline) {
this.vectorStore = vectorStore;
this.embeddingPipeline = embeddingPipeline;
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
queryEmbedding = await this.embeddingPipeline.getEmbeddingForQuery(query);
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
return { chunks: [], formattedContext: '', totalTokens: 0, meetingIds: [], intent };
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
                    const scores = await reranker.rerank(query, batch.map(chunk => chunk.text));
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
    return {
        chunks: candidateChunks,
        formattedContext: '',
        totalTokens: 0,
        meetingIds: [...new Set(candidateChunks.map(c => c.meetingId))],
        intent,
    };
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
const formattedContext = selected
.map(chunk => formatChunkForContext(chunk))
.join('\n\n');
return {
chunks: selected,
formattedContext,
totalTokens,
meetingIds: [...new Set(selected.map(c => c.meetingId))],
intent
};
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
// Embed query
let queryEmbedding: number[];
try {
queryEmbedding = await this.embeddingPipeline.getEmbeddingForQuery(query);
} catch (error) {
console.error('[RAGRetriever] Failed to embed query:', error);
return {
chunks: [],
formattedContext: '',
totalTokens: 0,
meetingIds: [],
intent
};
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
return {
chunks: selected,
formattedContext: contextParts.join('\n\n'),
totalTokens,
meetingIds: [...byMeeting.keys()],
intent
};
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
