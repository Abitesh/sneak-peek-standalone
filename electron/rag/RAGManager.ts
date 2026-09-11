// electron/rag/RAGManager.ts
// Central orchestrator for RAG pipeline
// Coordinates preprocessing, chunking, embedding, and retrieval
import Database from 'better-sqlite3';
import { LLMHelper } from '../LLMHelper';
import { preprocessTranscript, RawSegment } from './TranscriptPreprocessor';
import { chunkTranscript } from './SemanticChunker';
import { VectorStore } from './VectorStore';
import { EmbeddingPipeline } from './EmbeddingPipeline';
import { RAGRetriever, hasQuestionSpecificRelevance, type RagRetrievalResponse as RagRetrieverResponse } from './RAGRetriever';
import { LiveRAGIndexer } from './LiveRAGIndexer';
import { buildRAGPrompt } from './prompts';
import type { ProviderDataScopePolicy } from '../llm/ProviderRouter';
import { RagQueryPlanner, type RagQueryPlan, type RagQueryPlanningContext, type RagSourceSelection } from './RagQueryPlanner';
import { ConversationMemoryService } from '../intelligence/ConversationMemoryService';
import type { RAGConversationTurn } from './RAGRetriever';
import { evaluateRagRelevanceGate } from './RagRelevanceGate';
import type { EvidenceItem } from '../intelligence/context-os/evidencePack';
import type { EvidenceScope, SourceType } from '../context-intelligence/contracts/types';
import type { RetrievalPort } from '../context-intelligence/orchestration/orchestrator';
import type { LegacyChunk } from '../context-intelligence/retrieval/legacy-adapter';
import { createLegacyRetrievalPort } from '../context-intelligence/retrieval/legacy-retrieval-port';
import { MeetingRagAdapter } from './adapters/MeetingRagAdapter';
import { ModeRagAdapter } from './adapters/ModeRagAdapter';
import { PersonalRagAdapter } from './adapters/PersonalRagAdapter';
import { KnowledgeRagAdapter } from './adapters/KnowledgeRagAdapter';
import { isRagEnabled, isRagHybridEnabled, isRagConversationAwareEnabled, isRagConfidenceGateEnabled } from '../intelligence/intelligenceFlags';
interface ModesManagerLike {
getActiveModeInfo(): { id?: string } | null;
getActiveMode(): any | null;
getModes(): any[];
getReferenceFiles(modeId: string): any[];
retrieveHybridRaw(
mode: any,
files: any[],
options: {
query: string;
topK?: number;
tokenBudget?: number;
allowRerank?: boolean;
forceDocumentGrounding?: boolean;
},
): Promise<any>;
}
interface PersonalKnowledgeLike {
searchRelevantAsync(query: string, limit?: number): Promise<any[]>;
listFiles?(): any[];
searchRelevant?(query: string, limit?: number): any[];
search?(query: string, limit?: number): any[];
setEmbeddingServices?(embeddingPipeline: EmbeddingPipeline, vectorStore: VectorStore): void;
reindexEmbeddings?(): Promise<void>;
}
/**
* Canonical source kinds used by the unified RAG layer.
*
* These three values deliberately cover only the document/chunk sources that
* Change 2 is normalizing. Other evidence families in the application (for
* example profile, browser, OKF, and memory evidence) are not silently folded
* into this contract.
*/
export type RagSourceType = 'meeting' | 'mode' | 'personal' | 'knowledge';
export type RAGSource = RagSourceType;
/** A source document independent of its source-specific storage schema. */
export interface RagDocument {
id: string;
sourceType: RagSourceType;
name: string;
path?: string;
mimeType?: string;
metadata: Record<string, unknown>;
}
/** A canonical retrievable unit with source-specific provenance normalized into one shape. */
export interface RagChunk {
id: string;
documentId: string;
text: string;
pageStart?: number;
pageEnd?: number;
section?: string;
heading?: string;
chunkIndex: number;
startOffset?: number;
endOffset?: number;
speaker?: string;
timestampStart?: number;
timestampEnd?: number;
metadata: Record<string, unknown>;
}
/** Unified retrieval result. Source and chunk always travel together. */
export interface RagSearchResult {
chunk: RagChunk;
score: number;
semanticScore?: number;
lexicalScore?: number;
rerankScore?: number;
source: RagDocument;
}
/** @deprecated Use RagSearchResult. Kept as an export alias for Change 1 callers. */
export type UnifiedRAGResult = RagSearchResult;
export interface RAGSearchOptions {
source?: RagSourceType | 'all';
/** Conversation session used for retrieval-query rewriting and retrieval context. */
sessionId?: string;
/** Explicit prior turns for retrieval. When omitted, the shared manual memory is used. */
conversation?: readonly RAGConversationTurn[];
/** Explicit source-selection override. When omitted, RagQueryPlanner chooses sources. */
selectedSources?: readonly RagSourceSelection[];
meetingId?: string;
modeId?: string;
topK?: number;
/** Maximum candidates considered per retrieval source before final fusion. */
candidatePoolSize?: number;
/** Candidates sent to the local cross-encoder before final top-K. */
rerankCandidatePoolSize?: number;
tokenBudget?: number;
allowRerank?: boolean;
forceDocumentGrounding?: boolean;
}
/**
* A bare `for await` over an LLM stream blocks forever if the provider hangs
* mid-stream (no token, no error, no close) — this is the exact mechanism
* behind the previously-fixed 134s manual-chat hang (see electron/llm/
* liveDeadlines.ts). That fix (raceStreamWithDeadline) was wired into manual
* chat and WhatToAnswer but never into RAGManager's queryMeeting/queryGlobal,
* so the meeting-search and global-search chat surfaces were still exposed to
* an unbounded hang. This mirrors the same Promise.race-per-next() mechanism,
* reshaped to fit an `async *` generator (yield per token) instead of the
* callback-based onToken() the shared helper uses.
*/
const RAG_STREAM_STALL_MS = 15_000;
async function* raceGeneratorWithDeadline(
stream: AsyncGenerator<string, void, unknown>,
stallMs: number,
): AsyncGenerator<string, void, unknown> {
const DEADLINE = Symbol('rag-stream-deadline');
try {
while (true) {
let timer: ReturnType<typeof setTimeout> | undefined;
const deadline = new Promise<typeof DEADLINE>((resolve) => {
timer = setTimeout(() => resolve(DEADLINE), stallMs);
});
const nextP = stream.next();
// Defuse: if the deadline wins, nextP is still pending and unobserved —
// when the hung provider's request later settles it must not surface as
// an unhandledRejection (fatal in Electron main).
nextP.catch(() => { /* loser of the race — defused */ });
const res = await Promise.race([nextP, deadline]);
if (timer) clearTimeout(timer);
if (res === DEADLINE) {
console.warn(`[RAGManager] Stream stalled for ${stallMs}ms — aborting.`);
try { const p = stream.return?.(undefined); if (p && typeof (p as any).then === 'function') (p as Promise<unknown>).catch(() => {}); } catch { /* already closed */ }
return;
}
if (res.done) return;
// TS cannot discriminate the IteratorResult union through the
// Promise.race with the DEADLINE symbol, so `res.value` widens to
// `string | void` despite the `done` check above. The check makes
// the cast sound: a non-done result's value is the yielded string.
yield res.value as string;
}
} catch (e) {
try { const p = stream.return?.(undefined); if (p && typeof (p as any).then === 'function') (p as Promise<unknown>).catch(() => {}); } catch { /* already closed */ }
throw e;
}
}
export const NO_GROUNDED_EVIDENCE_PROMPT = `
<rag_retrieval_status>
NO GROUNDED EVIDENCE
The retrieval system found no relevant evidence for the user's question in the selected sources. Do not claim that any factual statement came from the documents or meetings. Do not invent, infer, or fabricate document facts or citations. If the question requires source-grounded information, say that you could not find the information in the available sources.
</rag_retrieval_status>`;

function appendRagRetrievalStatus(prompt: string, status: 'ok' | 'no_relevant_evidence'): string {
if (status !== 'no_relevant_evidence') return prompt;
return `${prompt}\n${NO_GROUNDED_EVIDENCE_PROMPT.trim()}`;
}

export interface RAGRetrievalResponse extends RagRetrieverResponse<RagSearchResult> {}

export interface RAGManagerConfig {
db: Database.Database;
// dbPath/extPath are unused by VectorStore now (it runs on `db` directly —
// see VectorStore.ts's header comment for why the worker-thread design
// that needed these was removed) but kept required here so every existing
// call site doesn't need to change, and so a future re-introduction of an
// out-of-process search path doesn't have to re-thread them.
dbPath: string;
extPath: string;
openaiKey?: string;
geminiKey?: string;
geminiKeys?: string[]; // optional pool for embedding key-rotation + 429 cooldown
ollamaUrl?: string;
providerDataScopes?: ProviderDataScopePolicy;
explicitKeyManagement?: boolean;
}
/**
* RAGManager - Central orchestrator for RAG operations
*
* Lifecycle:
* 1. Initialize with database and API key
* 2. When meeting ends: processMeeting() -> chunks + queue embeddings
* 3. When user queries: query() -> retrieve + stream response
*/
export interface RAGManagerRetrievalPortOptions {
  userId: string;
  scope?: EvidenceScope;
  modeId?: string;
  /** Source typing for mode-attached documents, supplied by the V3 caller. */
  modeSourceTypes?: ReadonlyMap<string, SourceType>;
  selectedSources?: readonly RagSourceSelection[];
  topK?: number;
  candidatePoolSize?: number;
  rerankCandidatePoolSize?: number;
  tokenBudget?: number;
  allowRerank?: boolean;
  forceDocumentGrounding?: boolean;
}

export class RAGManager {
private db: Database.Database;
private vectorStore: VectorStore;
private embeddingPipeline: EmbeddingPipeline;
private retriever: RAGRetriever;
private llmHelper: LLMHelper | null = null;
private liveIndexer: LiveRAGIndexer;
private queryPlanner: RagQueryPlanner;
private readonly meetingAdapter: MeetingRagAdapter;
private readonly modeAdapter: ModeRagAdapter;
private readonly personalAdapter: PersonalRagAdapter;
private readonly knowledgeAdapter: KnowledgeRagAdapter;
/**
* Change 1/18: source coordination lives here, while each source keeps ownership
* of its existing retrieval implementation behind a thin adapter. The application
* sees RAGManager.search(); specialized retrievers/managers remain internal.
* Source managers are resolved lazily so RAGManager remains safe to construct
* during AppState startup and does not introduce eager service cycles.
*/
private configurePersonalKnowledge(personalKnowledge?: PersonalKnowledgeLike | null): void {
try {
const manager = personalKnowledge ?? (require('../personalKnowledge').getPersonalKnowledgeManager() as PersonalKnowledgeLike);
manager.setEmbeddingServices?.(this.embeddingPipeline, this.vectorStore);
} catch (error) {
console.warn('[RAGManager] Personal embedding services unavailable:', error);
}
}
private getSourceManagers(): { modesManager: ModesManagerLike | null; personalKnowledge: PersonalKnowledgeLike | null } {
let modesManager: ModesManagerLike | null = null;
let personalKnowledge: PersonalKnowledgeLike | null = null;
try {
const { ModesManager } = require('../services/ModesManager');
modesManager = ModesManager.getInstance() as ModesManagerLike;
} catch (error) {
console.warn('[RAGManager] Mode source unavailable:', error);
}
try {
const { getPersonalKnowledgeManager } = require('../personalKnowledge');
personalKnowledge = getPersonalKnowledgeManager() as PersonalKnowledgeLike;
this.configurePersonalKnowledge(personalKnowledge);
} catch (error) {
console.warn('[RAGManager] Personal source unavailable:', error);
}
return { modesManager, personalKnowledge };
}
/**
* Guards against concurrent reprocessMeeting()/reindex calls for the same
* target. Process-wide on globalThis, not per-instance: RAGManager is
* constructor-owned (not a getInstance singleton), so a harness that
* constructs two instances over ONE natively.db — or co-loads two esbuild
* bundles — would otherwise run duplicate embedding jobs for the same
* documents (duplicate spend; duplicate vectors if inserts aren't
* idempotent). Same bug class as the 2026-07-31 singleton sweep, LOW
* severity because the DB itself is shared truth.
*/
private get _jobGuards(): { reprocess: Set<string>; reindexing: boolean } {
const g = globalThis as unknown as Record<string, { reprocess: Set<string>; reindexing: boolean } | undefined>;
if (!g.__nativelyRagJobGuardsV1__) g.__nativelyRagJobGuardsV1__ = { reprocess: new Set(), reindexing: false };
return g.__nativelyRagJobGuardsV1__;
}
private get _reprocessInFlight(): Set<string> { return this._jobGuards.reprocess; }
constructor(config: RAGManagerConfig) {
this.db = config.db;
this.vectorStore = new VectorStore(config.db, config.dbPath, config.extPath);
this.embeddingPipeline = new EmbeddingPipeline(config.db, this.vectorStore);
this.retriever = new RAGRetriever(this.vectorStore, this.embeddingPipeline);
this.liveIndexer = new LiveRAGIndexer(this.vectorStore, this.embeddingPipeline);
this.queryPlanner = new RagQueryPlanner();
this.meetingAdapter = new MeetingRagAdapter(this.retriever, this.db);
this.modeAdapter = new ModeRagAdapter();
this.personalAdapter = new PersonalRagAdapter(this.db);
this.knowledgeAdapter = new KnowledgeRagAdapter();
this.embeddingPipeline.initialize({
openaiKey: config.openaiKey,
geminiKey: config.geminiKey,
geminiKeys: config.geminiKeys,
ollamaUrl: config.ollamaUrl,
providerDataScopes: config.providerDataScopes,
explicitKeyManagement: config.explicitKeyManagement,
}).then(() => {
this.configurePersonalKnowledge();
// Backfill provider metadata for meetings that were embedded before the
// embedding_provider column was written (or where the write failed silently).
this._backfillEmbeddingProviderMetadata();
// Auto-reindex meetings left in an incompatible embedding space (e.g. after
// a Gemini embedding-model bump). No-op when everything already matches.
this.scheduleAutoReindex();
}).catch(() => { /* non-critical, suppress */ });
}
/**
* Unified retrieval entry point for the application.
*
* Change 2 adds canonical document/chunk/result objects here without
* changing the underlying Meeting, Mode, or Personal retrieval algorithms.
* Each adapter preserves only metadata that the existing source actually
* provides; missing provenance remains undefined rather than fabricated.
*/
private getConversationForRetrieval(
sessionId?: string,
conversation?: readonly RAGConversationTurn[],
): readonly RAGConversationTurn[] | undefined {
if (conversation?.length) return conversation.slice(-8);
if (!sessionId) return undefined;
try {
const memory = ConversationMemoryService.getShared();
const turns = memory?.getRecentTurns(sessionId, 8) ?? [];
if (!turns.length) return undefined;
return turns.map(turn => ({
userMessage: turn.userMessage,
assistantAnswer: turn.assistantAnswer,
mode: turn.mode,
timestamp: turn.timestamp,
}));
} catch (error) {
console.warn('[RAGManager] Conversation context unavailable; continuing without it:', error);
return undefined;
}
}
private gateCanonicalResults(
  results: RagSearchResult[],
  query: string,
): RagSearchResult[] {
if (!results.length) return [];
const relevantResults = results.filter((result) =>
  hasQuestionSpecificRelevance(query, [result.chunk as any], this.retriever.detectIntent(query)),
);
if (!relevantResults.length) return [];
// Change 21: the canonical confidence-gate setting is authoritative for the
// unified manager's confidence/sufficiency decision. Keep the existing
// question-specific relevance check even when the confidence gate is off so
// disabling confidence does not turn retrieval into an unconditional bypass.
if (!isRagConfidenceGateEnabled()) return relevantResults;
const evidenceItems = results.map((result, index) => ({
  evidenceId: `rag-manager:${String(result.chunk.id ?? index)}`,
  sourceKind: result.source.sourceType,
  sourceId: result.source.id,
  sourceOwner: 'application',
  authority: 'evidence',
  trustLevel: 'retrieved',
  text: result.chunk.text,
  pointer: {
    chunkId: result.chunk.id,
    fileId: result.source.sourceType === 'personal' ? result.source.id : undefined,
    meetingId: result.source.sourceType === 'meeting' ? result.source.id : undefined,
    page: result.chunk.pageStart,
  },
  documentName: result.source.name,
  pageStart: result.chunk.pageStart,
  pageEnd: result.chunk.pageEnd,
  section: result.chunk.section,
  heading: result.chunk.heading,
  documentId: result.chunk.documentId,
  chunkId: result.chunk.id,
  retrievalScore: result.score,
  rerankScore: result.rerankScore,
  supports: { property: 'unknown' },
  score: {
    lexical: result.lexicalScore,
    vector: result.semanticScore,
    rerank: result.rerankScore,
    final: result.score,
  },
  reasonIncluded: 'retrieval',
})) as unknown as EvidenceItem[];
const decision = evaluateRagRelevanceGate({
  items: evidenceItems,
  requestedProperty: 'unknown',
  isSynthesis: true,
});
if (!decision.passed) return [];
const usable = new Set(decision.usableEvidenceIds);
return relevantResults.filter((result, index) => usable.has(`rag-manager:${String(result.chunk.id ?? index)}`));
}

/**
 * Build the Context Intelligence retrieval port used by normal/manual chat.
 *
 * Change 17: manual chat must not construct separate mode/personal/meeting
 * retrieval ports beside RAGManager. RAGManager owns candidate generation,
 * source-family retrieval, common reranking and the canonical relevance gate.
 * The existing legacy-retrieval-port remains the single V3 authorization and
 * scope/version filter after those candidates are produced.
 *
 * Profile Intelligence is intentionally not folded in here. It is a distinct
 * authoritative source family and continues through its existing profile port
 * until the source-adapter consolidation in Change 18/20.
 */
public createRAGRetrievalPort(
  options: RAGManagerRetrievalPortOptions,
): RetrievalPort {
  const sourceTypes = new Map<string, SourceType>();
  const activeVersions = new Map<string, string>();
  const chunkVersions = new Map<string, string>();
  const sourceScopes = new Map<string, EvidenceScope>();

  // Declare stable document sources before retrieval where possible. Meeting
  // sources are discovered from returned chunks because the meeting store has
  // no file registry; its source id is the meeting id itself.
  try {
    const { modesManager, personalKnowledge } = this.getSourceManagers();
    const modeId = options.modeId ?? modesManager?.getActiveModeInfo?.()?.id;
    if (modeId && modesManager) {
      for (const file of modesManager.getReferenceFiles(modeId) ?? []) {
        const id = String(file?.id ?? '');
        if (!id) continue;
        sourceTypes.set(id, options.modeSourceTypes?.get(id) ?? 'REFERENCE_FILE');
        activeVersions.set(id, 'legacy');
        chunkVersions.set(id, 'legacy');
        sourceScopes.set(id, { userId: options.userId });
      }
    }
    for (const file of personalKnowledge?.listFiles?.() ?? []) {
      const id = String(file?.id ?? '');
      if (!id) continue;
      sourceTypes.set(id, 'REFERENCE_FILE');
      activeVersions.set(id, 'current');
      chunkVersions.set(id, 'current');
      sourceScopes.set(id, {
        userId: options.userId,
        ...(options.scope?.sessionId ? { sessionId: options.scope.sessionId } : {}),
      });
    }
  } catch { /* source registry is completed lazily below */ }

  return createLegacyRetrievalPort({
    registry: { sourceTypes, activeVersions, chunkVersions, sourceScopes },
    retrieve: async (query: string, opts: { topK: number }): Promise<LegacyChunk[]> => {
      const response = await this.search(query, {
        selectedSources: options.selectedSources,
        modeId: options.modeId,
        meetingId: options.scope?.meetingId,
        sessionId: options.scope?.sessionId,
        topK: Math.max(1, opts.topK),
        candidatePoolSize: options.candidatePoolSize,
        rerankCandidatePoolSize: options.rerankCandidatePoolSize,
        tokenBudget: options.tokenBudget,
        allowRerank: options.allowRerank !== false,
        forceDocumentGrounding: options.forceDocumentGrounding,
      });

      for (const result of response.results) {
        const sourceId = String(result.source.id);
        let sourceType: SourceType;
        if (result.source.sourceType === 'meeting') {
          sourceType = 'MEETING_TRANSCRIPT';
          activeVersions.set(sourceId, 'live');
          chunkVersions.set(sourceId, 'live');
          sourceScopes.set(sourceId, {
            userId: options.userId,
            meetingId: options.scope?.meetingId ?? sourceId,
          });
        } else if (result.source.sourceType === 'personal') {
          sourceType = 'REFERENCE_FILE';
          activeVersions.set(sourceId, activeVersions.get(sourceId) ?? 'current');
          chunkVersions.set(sourceId, chunkVersions.get(sourceId) ?? 'current');
          sourceScopes.set(sourceId, sourceScopes.get(sourceId) ?? {
            userId: options.userId,
            ...(options.scope?.sessionId ? { sessionId: options.scope.sessionId } : {}),
          });
        } else {
          sourceType = options.modeSourceTypes?.get(sourceId)
            ?? sourceTypes.get(sourceId)
            ?? 'REFERENCE_FILE';
          activeVersions.set(sourceId, activeVersions.get(sourceId) ?? 'legacy');
          chunkVersions.set(sourceId, chunkVersions.get(sourceId) ?? 'legacy');
          sourceScopes.set(sourceId, sourceScopes.get(sourceId) ?? { userId: options.userId });
        }
        sourceTypes.set(sourceId, sourceType);
      }

      return response.results.map((result): LegacyChunk => ({
        sourceId: String(result.source.id),
        fileName: result.source.name,
        text: result.chunk.text,
        chunkIndex: result.chunk.chunkIndex,
        score: result.score,
        ftsScore: result.lexicalScore,
        vectorScore: result.semanticScore,
        rerankScore: result.rerankScore,
        provenance: result.source.sourceType === 'meeting'
          ? (process.env.NATIVELY_TEST_TRANSCRIPT_INJECTION === '1' ? 'TEST_TRANSCRIPT' : 'LIVE_STT')
          : result.source.sourceType === 'personal' ? 'PERSONAL_FILE' : 'MODE_REFERENCE_FILE',
        metadata: {
          ...(result.chunk.pageStart !== undefined ? { pageStart: result.chunk.pageStart } : {}),
          ...(result.chunk.pageEnd !== undefined ? { pageEnd: result.chunk.pageEnd } : {}),
          ...(result.chunk.section ? { section: result.chunk.section } : {}),
          ...(result.chunk.heading ? { heading: result.chunk.heading } : {}),
          ...(result.chunk.metadata ?? {}),
        },
      }));
    },
  });
}

async search(query: string, options: RAGSearchOptions = {}): Promise<RAGRetrievalResponse> {
const originalQuery = String(query ?? '').trim();
if (!originalQuery) return { status: 'no_relevant_evidence', results: [], confidence: 0 };
if (!isRagEnabled()) return { status: 'no_relevant_evidence', results: [], confidence: 0 };
// Change 8: query planning is an explicit retrieval-stage concern. The
// original user question remains untouched for answer generation; only
// retrieval receives the rewritten query.
// Change 10: the same planner now chooses the source families to consult.
const { modesManager, personalKnowledge } = this.getSourceManagers();
const activeModeInfo = modesManager?.getActiveModeInfo?.() ?? null;
const planningContext: RagQueryPlanningContext = {
hasModeReferenceFiles: Boolean(modesManager && (options.modeId || activeModeInfo?.id)),
hasPersonalFiles: Boolean(personalKnowledge),
// Meeting retrieval can search globally when no meetingId is supplied, so
// keep the meeting source available to the planner. The final query's
// intent still decides whether it is actually selected.
hasMeeting: true,
};
const queryPlan: RagQueryPlan = this.queryPlanner.plan(
originalQuery,
options.sessionId,
planningContext,
);
const normalizedQuery = queryPlan.retrievalQuery;
const legacySourceSelection: RagSourceSelection[] | undefined = options.source
? options.source === 'meeting'
? ['meeting']
: options.source === 'mode'
? ['mode-reference']
: options.source === 'personal'
? ['personal-files']
: ['meeting', 'mode-reference', 'knowledge', 'personal-files']
: undefined;
const selectedSources = Array.isArray(options.selectedSources)
? [...new Set(options.selectedSources)]
: (legacySourceSelection ?? queryPlan.sources);
const sourceSet = new Set<RagSourceSelection>(selectedSources);
const conversation = sourceSet.has('conversation') && isRagConversationAwareEnabled()
? this.getConversationForRetrieval(options.sessionId, options.conversation)
: undefined;

// Change 21: when unified RAG hybrid mode is off, retain only the primary
// source family selected for this query. The underlying single-source hybrid
// algorithms (lexical + semantic) remain untouched; this switch only controls
// cross-source fusion at the RAGManager boundary.
const effectiveSourceSet = isRagHybridEnabled()
? sourceSet
: new Set<RagSourceSelection>(
    selectedSources.filter((source) => source !== 'conversation').slice(0, 1),
  );
const topK = Math.max(1, Math.min(50, options.topK ?? 8));
const candidatePoolSize = Math.max(topK, Math.min(1000, options.candidatePoolSize ?? 100));
const rerankCandidatePoolSize = Math.max(
topK,
Math.min(candidatePoolSize, Math.min(1000, options.rerankCandidatePoolSize ?? candidatePoolSize)),
);
const tokenBudget = Math.max(1, options.tokenBudget ?? 1800);
const results: RagSearchResult[] = [];
if (effectiveSourceSet.has('meeting')) {
try {
const meetingResults = await this.meetingAdapter.retrieve({
query: normalizedQuery,
options,
candidatePoolSize,
tokenBudget,
conversation,
});
results.push(...meetingResults);
} catch (error) {
console.warn('[RAGManager] Meeting adapter retrieval failed:', error);
}
}
if (effectiveSourceSet.has('mode-reference')) {
try {
const modeResults = await this.modeAdapter.retrieve({
query: normalizedQuery,
options,
candidatePoolSize,
tokenBudget,
});
results.push(...modeResults);
} catch (error) {
console.warn('[RAGManager] Mode adapter retrieval failed:', error);
}
}
if (effectiveSourceSet.has('knowledge')) {
try {
const knowledgeResults = await this.knowledgeAdapter.retrieve({
query: normalizedQuery,
options,
candidatePoolSize,
tokenBudget,
conversation,
});
results.push(...knowledgeResults);
} catch (error) {
console.warn('[RAGManager] Knowledge adapter retrieval failed:', error);
}
}
if (effectiveSourceSet.has('personal-files')) {
try {
const personalResults = await this.personalAdapter.retrieve({
query: normalizedQuery,
options,
candidatePoolSize,
});
results.push(...personalResults);
} catch (error) {
console.warn('[RAGManager] Personal adapter retrieval failed:', error);
}
}
// Final common-layer fusion boundary: source adapters provide candidates,
// then the shared BGE reranker applies the final relevance ordering before
// the public top-K boundary.
if (options.allowRerank !== false) {
const reranked = await this.rerankCanonicalResults(
normalizedQuery,
results,
rerankCandidatePoolSize,
);
results.splice(0, results.length, ...reranked);
}
results.sort((a, b) => b.score - a.score);
const finalResults = this.gateCanonicalResults(results.slice(0, topK), normalizedQuery);
if (finalResults.length === 0) {
return { status: 'no_relevant_evidence', results: [], confidence: 0 };
}
return {
status: 'ok',
results: finalResults,
confidence: Math.max(...finalResults.map(result => Number(result.score) || 0), 0),
};
}
/**
* Apply the shared local BGE cross-encoder to canonical results that reach
* the unified manager. Source-specific retrieval remains responsible for
* candidate generation; this is the common final relevance stage.
*
* The existing LocalReranker owns the ONNX worker/lifecycle. We batch at six
* passages to preserve the native-memory safety already used by ModeHybridRetriever.
* Any failure leaves the pre-rerank result ordering untouched.
*/
private async rerankCanonicalResults(
query: string,
results: RagSearchResult[],
candidatePoolSize: number,
): Promise<RagSearchResult[]> {
if (results.length < 2) return results;
let enabled = false;
try {
const { isRagRerankEnabled } = require('../intelligence/intelligenceFlags') as typeof import('../intelligence/intelligenceFlags');
enabled = isRagRerankEnabled();
} catch {
return results;
}
if (!enabled) return results;
try {
const { getLocalReranker } = require('./LocalReranker') as typeof import('./LocalReranker');
const reranker = getLocalReranker() as {
rerank: (q: string, passages: string[]) => Promise<Array<{ index: number; score: number }> | null>;
};
const pool = results.slice(0, Math.min(candidatePoolSize, results.length));
const reranked: Array<{ result: RagSearchResult; score: number }> = [];
const batchSize = 6;
for (let start = 0; start < pool.length; start += batchSize) {
const batch = pool.slice(start, start + batchSize);
const scores = await reranker.rerank(query, batch.map(result => result.chunk.text));
if (!scores || scores.length < batch.length) {
throw new Error('local reranker returned incomplete scores');
}
for (const item of scores) {
const index = Number(item.index);
if (!Number.isInteger(index) || index < 0 || index >= batch.length) continue;
const rawScore = Number(item.score);
if (!Number.isFinite(rawScore)) continue;
reranked.push({ result: batch[index], score: rawScore });
}
}
if (reranked.length !== pool.length) return results;
const byId = new Map(
reranked.map(item => [item.result.chunk.id, { ...item.result, rerankScore: item.score }]),
);
const ranked = results.map(result => {
const rerankedResult = byId.get(result.chunk.id);
if (!rerankedResult) return result;
const normalized = 1 / (1 + Math.exp(-rerankedResult.rerankScore!));
return {
...rerankedResult,
score: normalized,
};
});
ranked.sort((a, b) => b.score - a.score);
return ranked;
} catch (error) {
console.warn('[RAGManager] Local rerank failed; keeping unified retrieval order:', error);
return results;
}
}
/**
* Change 8: expose the query-planning result for diagnostics/tests while
* keeping originalQuery separate from the retrieval-only rewrite.
*/
planQuery(
query: string,
sessionId?: string,
context: RagQueryPlanningContext = {},
): RagQueryPlan {
return this.queryPlanner.plan(String(query ?? '').trim(), sessionId, context);
}
/**
* Alias for callers that use retrieval terminology. Kept intentionally thin so
* there is still exactly one unified search implementation.
*/
async retrieve(query: string, options: RAGSearchOptions = {}): Promise<RAGRetrievalResponse> {
return this.search(query, options);
}
/**
* Set LLM helper for generating responses
*/
setLLMHelper(llmHelper: LLMHelper): void {
this.llmHelper = llmHelper;
}
/**
* The retriever, for callers that need typed chunks rather than a formatted
* blob — specifically the Context Intelligence V3 meeting retrieval port,
* which builds its own evidence with per-meeting scope.
*
* Read-only accessor: retrieval itself stays owned by RAGRetriever, so this
* does not become a second query path with its own ranking rules.
*/
getRetriever(): RAGRetriever {
return this.retriever;
}
getEmbeddingPipeline(): EmbeddingPipeline {
return this.embeddingPipeline;
}
initializeEmbeddings(keys: { openaiKey?: string, geminiKey?: string, geminiKeys?: string[], ollamaUrl?: string, providerDataScopes?: ProviderDataScopePolicy, explicitKeyManagement?: boolean }): void {
const initPromise = this.embeddingPipeline.initialize({
...keys,
explicitKeyManagement: keys.explicitKeyManagement,
});
// After init, backfill embedding_provider on meetings that have embedded chunks
// but a NULL metadata column (common for meetings embedded before this metadata
// write was introduced, or where the write silently failed).
if (initPromise && typeof initPromise.then === 'function') {
initPromise.then(() => {
this._backfillEmbeddingProviderMetadata();
this.scheduleAutoReindex();
}).catch(() => { /* silent — backfill is non-critical */ });
} else {
// Synchronous path (shouldn't happen but be safe)
this._backfillEmbeddingProviderMetadata();
this.scheduleAutoReindex();
}
}
private _backfillEmbeddingProviderMetadata(): void {
const providerName = this.embeddingPipeline.getActiveProviderName();
const dimensions = this.embeddingPipeline.getActiveDimensions();
if (providerName && dimensions) {
// Stamps provider/dims only — NOT embedding_space. Space is owned by the
// re-index sweep so a NULL-space legacy row can't be mislabeled as the
// active space (which would skip re-index → silent garbage).
this.vectorStore.backfillEmbeddingProviderMetadata(providerName, dimensions);
}
}
/**
* Check if RAG is ready for queries
*/
isReady(): boolean {
return this.embeddingPipeline.isReady() && this.llmHelper !== null;
}
/**
* Process a meeting after it ends
* Creates chunks and queues them for embedding
*/
async processMeeting(
meetingId: string,
transcript: RawSegment[],
summary?: string
): Promise<{ chunkCount: number }> {
console.log(`[RAGManager] Processing meeting ${meetingId} with ${transcript.length} segments`);
// 1. Preprocess transcript
const cleaned = preprocessTranscript(transcript);
console.log(`[RAGManager] Preprocessed to ${cleaned.length} cleaned segments`);
// 2. Chunk the transcript
const chunks = chunkTranscript(meetingId, cleaned);
console.log(`[RAGManager] Created ${chunks.length} chunks`);
if (chunks.length === 0) {
console.log(`[RAGManager] No chunks to save for meeting ${meetingId}`);
return { chunkCount: 0 };
}
// 3. Save chunks to database
this.vectorStore.saveChunks(chunks);
// 4. Save summary if provided
if (summary) {
this.vectorStore.saveSummary(meetingId, summary);
}
// 5. Queue for embedding (background processing)
if (this.embeddingPipeline.isReady()) {
await this.embeddingPipeline.queueMeeting(meetingId);
} else {
console.log(`[RAGManager] Embeddings not ready, chunks saved without embeddings`);
}
return { chunkCount: chunks.length };
}
/**
* Query meeting with RAG
* Returns streaming generator for response
*/
async *queryMeeting(
meetingId: string,
query: string,
abortSignal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
if (!this.llmHelper) {
throw new Error('LLM helper not initialized');
}
// Retrieval itself now owns the no-evidence state. We do not convert missing
// embeddings into a generic wrapper fallback; lexical retrieval may still be
// useful, and if nothing survives retrieval the result is explicitly empty.
const context = await this.retriever.retrieve(query, { meetingId });
const promptContext = context.status === 'no_relevant_evidence'
? appendRagRetrievalStatus('', context.status)
: context.formattedContext;
// Build prompt with intent hint. The explicit status tells the model that no
// grounded evidence was found and prevents unsupported facts being presented
// as document-derived.
const prompt = buildRAGPrompt(query, promptContext, 'meeting', context.intent);
// Stream response
const streamOutcome: { incomplete?: boolean } = {};
const stream = this.llmHelper.streamChatWithGemini(prompt, undefined, undefined, true, undefined, streamOutcome);
for await (const chunk of raceGeneratorWithDeadline(stream, RAG_STREAM_STALL_MS)) {
if (abortSignal?.aborted) break;
yield chunk;
}
// F7 (code-review 2026-08-14): surface an incomplete stream to the
// reader. Without this, a capped or post-commit-failed stream ended
// normally, ipcHandlers sent rag:stream-complete, and the renderer
// finalized a mid-sentence bubble as a complete answer that then
// entered conversation state. The coda makes the truncation VISIBLE
// in the rendered/persisted answer (skipped on user abort — that is
// a cancellation, not a truncation).
if (streamOutcome.incomplete && !abortSignal?.aborted) {
yield '\n\n_(Answer incomplete \u2014 the model stream ended early.)_';
}
}
/**
* Query across all meetings (global search)
*/
async *queryGlobal(
query: string,
abortSignal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
if (!this.llmHelper) {
throw new Error('LLM helper not initialized');
}
// Retrieve from all meetings. A miss is now a first-class retrieval state.
const context = await this.retriever.retrieveGlobal(query);
const promptContext = context.status === 'no_relevant_evidence'
? appendRagRetrievalStatus('', context.status)
: context.formattedContext;
// Build prompt with intent hint and an explicit no-evidence instruction when
// retrieval found nothing relevant.
const prompt = buildRAGPrompt(query, promptContext, 'global', context.intent);
// Stream response
const streamOutcome: { incomplete?: boolean } = {};
const stream = this.llmHelper.streamChatWithGemini(prompt, undefined, undefined, true, undefined, streamOutcome);
for await (const chunk of raceGeneratorWithDeadline(stream, RAG_STREAM_STALL_MS)) {
if (abortSignal?.aborted) break;
yield chunk;
}
// F7 (code-review 2026-08-14): surface an incomplete stream to the
// reader. Without this, a capped or post-commit-failed stream ended
// normally, ipcHandlers sent rag:stream-complete, and the renderer
// finalized a mid-sentence bubble as a complete answer that then
// entered conversation state. The coda makes the truncation VISIBLE
// in the rendered/persisted answer (skipped on user abort — that is
// a cancellation, not a truncation).
if (streamOutcome.incomplete && !abortSignal?.aborted) {
yield '\n\n_(Answer incomplete \u2014 the model stream ended early.)_';
}
}
/**
* Smart query - auto-detects scope
*/
async *query(
query: string,
currentMeetingId?: string,
abortSignal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
const scope = this.retriever.detectScope(query, currentMeetingId);
if (scope === 'meeting' && currentMeetingId) {
yield* this.queryMeeting(currentMeetingId, query, abortSignal);
} else {
yield* this.queryGlobal(query, abortSignal);
}
}
/**
* Get embedding queue status
*/
getQueueStatus(): { pending: number; processing: number; completed: number; failed: number } {
return this.embeddingPipeline.getQueueStatus();
}
/**
* Retry pending embeddings
*/
async retryPendingEmbeddings(): Promise<void> {
await this.embeddingPipeline.processQueue();
}
/**
* Check if a meeting has been processed for RAG
*/
isMeetingProcessed(meetingId: string): boolean {
return this.vectorStore.hasEmbeddings(meetingId);
}
// ─── JIT RAG: Live Meeting Indexing ──────────────────────────────
/**
* Start JIT indexing for a live meeting.
* Call when a meeting session begins.
*/
startLiveIndexing(meetingId: string): void {
if (!this.embeddingPipeline.isReady()) {
console.log('[RAGManager] Embedding pipeline not ready, skipping live indexing');
return;
}
// F-411: purge anything still sitting under this id BEFORE indexing the
// new session. The live id is a CONSTANT ('live-meeting-current'), and
// the only cleanup is at meeting end — guarded by !isMeetingActive, and
// deliberately skipped when a new meeting has already started. So after
// a crash, a force-quit, or a start that overlaps the previous drain,
// the previous meeting's transcript chunks survive under the same id;
// the live "ask about this meeting" surface filters only on meeting_id,
// so meeting A's transcript was served as evidence for meeting B.
// There is no startup sweep anywhere, and `chunks` has no
// UNIQUE(meeting_id, chunk_index) to stop the rows interleaving.
// Purging here is the one place that runs on EVERY path into a new
// live session, and it is safe: these JIT rows are always disposable
// (post-meeting RAG re-indexes under the real meeting id).
try {
this.deleteMeetingData(meetingId);
} catch (e) {
console.warn('[RAGManager] Failed to purge stale live-indexing data before start:', e);
}
// Ensure meeting row exists in DB to satisfy foreign key constraints for chunks
try {
this.db.prepare(`
INSERT OR IGNORE INTO meetings (id, title, start_time, duration_ms, summary_json, created_at, source, is_processed)
VALUES (?, 'Live Meeting', ?, 0, '{}', ?, 'manual', 0)
`).run(meetingId, Date.now(), new Date().toISOString());
} catch (e) {
console.warn('[RAGManager] Failed to create transient meeting row for live indexing', e);
}
this.liveIndexer.start(meetingId);
}
/**
* Feed new transcript segments to the live indexer.
* Call whenever new transcript arrives during the meeting.
*/
feedLiveTranscript(segments: RawSegment[]): void {
this.liveIndexer.feedSegments(segments);
}
/**
* Stop JIT indexing (flushes remaining segments).
* Call when the meeting session ends.
* NOTE: The post-meeting processMeeting() will later replace JIT chunks
* with the complete, properly indexed version.
*/
async stopLiveIndexing(): Promise<void> {
await this.liveIndexer.stop();
}
/**
* Check if JIT indexing is active for a meeting.
*/
isLiveIndexingActive(meetingId?: string): boolean {
if (meetingId) {
return this.liveIndexer.getActiveMeetingId() === meetingId;
}
return this.liveIndexer.isRunning();
}
/**
* Check if JIT indexing has produced at least one queryable (embedded) chunk.
* Prevents wasted queryMeeting() calls that immediately throw NO_MEETING_EMBEDDINGS.
*/
hasLiveChunks(): boolean {
return this.liveIndexer.hasIndexedChunks();
}
/**
* Whether this instance's connection can still serve statements. Mirrors
* VectorStore.isDatabaseUsable() — see that method for the full rationale.
*/
private isDatabaseUsable(): boolean {
try {
return (this.db as any)?.open === true;
} catch {
return false;
}
}
/**
* Delete RAG data for a meeting
*/
deleteMeetingData(meetingId: string): void {
// Shutdown guard: RAGManager holds a RAW better-sqlite3 handle
// (`this.db = config.db`), so after the fatal path's
// closeWithoutCheckpoint() this reference is a closed connection and
// every prepare() below would throw out of the driver. This method is
// called from the background meeting-teardown block, where a throw is
// caught but aborts the remaining teardown steps. Return one controlled,
// logged result instead of three separate driver failures.
//
// Defense in depth for the shutdown window only — nothing here reopens
// the database.
if (!this.isDatabaseUsable()) {
console.warn(
`[RAGManager] deleteMeetingData(${meetingId}): database is closed — skipping RAG cleanup. ` +
'Expected during fatal shutdown.'
);
return;
}
// 1. Delete from vector store (chunks and summaries)
this.vectorStore.deleteChunksForMeeting(meetingId);
// 2. Clear embedding queue for this meeting to prevent "Chunk not found" errors on re-processing
try {
const info = this.db.prepare('DELETE FROM embedding_queue WHERE meeting_id = ?').run(meetingId);
if (info.changes > 0) {
console.log(`[RAGManager] Cleared ${info.changes} items from embedding_queue for meeting ${meetingId}`);
}
} catch (e) {
console.warn(`[RAGManager] Failed to clear embedding_queue for meeting ${meetingId}`, e);
}
// 3. Clean up transient meeting row if it was a live session
try {
if (meetingId === 'live-meeting-current') {
this.db.prepare('DELETE FROM meetings WHERE id = ?').run(meetingId);
}
} catch (e) {
console.warn('[RAGManager] Failed to delete transient meeting row', e);
}
}
/**
* Manually trigger processing for a meeting
* Useful for demo meetings or reprocessing failed ones
*/
async reprocessMeeting(meetingId: string): Promise<void> {
// Guard: if this meeting is already being reprocessed, skip to prevent
// concurrent runs from clearing each other's queue work.
if (this._reprocessInFlight.has(meetingId)) {
console.log(`[RAGManager] Reprocessing already in-flight for ${meetingId}, skipping duplicate call`);
return;
}
this._reprocessInFlight.add(meetingId);
console.log(`[RAGManager] Reprocessing meeting ${meetingId}`);
try {
// delete existing RAG data first to avoid duplicates
this.deleteMeetingData(meetingId);
// Fetch meeting details from DB
const { DatabaseManager } = require('../db/DatabaseManager');
const meeting = DatabaseManager.getInstance().getMeetingDetails(meetingId);
if (!meeting) {
console.error(`[RAGManager] Meeting ${meetingId} not found for reprocessing`);
return;
}
if (!meeting.transcript || meeting.transcript.length === 0) {
console.log(`[RAGManager] Meeting ${meetingId} has no transcript, skipping`);
return;
}
// Convert to RawSegment format
const segments = meeting.transcript.map((t: any) => ({
speaker: t.speaker,
text: t.text,
timestamp: t.timestamp
}));
// Get summary if available
let summary: string | undefined;
if (meeting.detailedSummary) {
summary = [
...(meeting.detailedSummary.overview ? [meeting.detailedSummary.overview] : []),
...(meeting.detailedSummary.keyPoints || []),
...(meeting.detailedSummary.actionItems || []).map((a: any) => `Action: ${a}`)
].join('. ');
} else if (meeting.summary) {
summary = meeting.summary;
}
await this.processMeeting(meetingId, segments, summary);
} finally {
this._reprocessInFlight.delete(meetingId);
}
}
/**
* Ensure demo meeting is processed
* Checks if demo meeting exists but has no chunks, then processes it
*/
async ensureDemoMeetingProcessed(): Promise<void> {
const demoId = 'demo-meeting'; // Corrected ID to match DatabaseManager
// Check if demo meeting exists in DB
const { DatabaseManager } = require('../db/DatabaseManager');
const meeting = DatabaseManager.getInstance().getMeetingDetails(demoId);
if (!meeting) {
// console.log('[RAGManager] Demo meeting not found in DB, skipping RAG processing');
return;
}
// Check if already processed (has embeddings)
if (this.isMeetingProcessed(demoId)) {
// console.log('[RAGManager] Demo meeting already processed');
return;
}
// Guard: also check the in-flight set — reprocessMeeting() itself is guarded,
// but checking here avoids even printing the "Processing now..." log redundantly.
if (this._reprocessInFlight.has(demoId)) {
console.log(`[RAGManager] Demo meeting reprocessing already in-flight, skipping`);
return;
}
console.log('[RAGManager] Demo meeting found but not processed. Processing now...');
await this.reprocessMeeting(demoId);
}
/**
* Cleanup stale queue items for meetings that no longer exist
*/
public cleanupStaleQueueItems(): void {
try {
const info = this.db.prepare(`
DELETE FROM embedding_queue
WHERE meeting_id NOT IN (SELECT id FROM meetings)
`).run();
if (info.changes > 0) {
console.log(`[RAGManager] Cleaned up ${info.changes} stale queue items`);
}
} catch (error) {
console.error('[RAGManager] Failed to cleanup stale queue items:', error);
}
}
/**
* Manual re-index entry point (settings button / IPC). Delegates to the same
* guarded routine as the automatic path so the two can't run concurrently and
* double-clear/double-queue.
*/
async reindexIncompatibleMeetings(): Promise<void> {
await this._runReindex();
}
/**
* Automatically re-index meetings whose embedding space differs from the
* active one (e.g. after the gemini-embedding-001 → gemini-embedding-2 bump).
*
* Design:
* - Triggered off the incompatible COUNT (not lastSpace != activeSpace) so a
* crash mid-reindex resumes next launch.
* - Each meeting is cleared AND queued in ONE transaction (requeueMeetingForReindex)
* so a crash can never orphan a meeting (cleared vectors but no queue rows).
* The durable embedding_queue + the pipeline's startup queue-flush is the
* resume mechanism.
* - Deferred ~15s so it doesn't compete with cold-start UI/STT.
* - Paused while a live meeting indexes (live > backfill), but the pause is
* CAPPED so a back-to-back-meetings session can't strand the in-flight flag
* or leave the progress toast spinning forever; it bails and retries next launch.
* - Idempotent: a second call (auto or manual) while one is in flight is a no-op.
* - Search during re-index is empty-not-wrong: a cleared, not-yet-re-embedded
* meeting has NULL space and is excluded by the space-filtered search.
*/
private get _reindexInFlight(): boolean { return this._jobGuards.reindexing; }
private set _reindexInFlight(v: boolean) { this._jobGuards.reindexing = v; }
private _autoReindexTimer: ReturnType<typeof setTimeout> | null = null;
private static readonly AUTO_REINDEX_DEFER_MS = 15_000;
private static readonly REINDEX_LIVE_RECHECK_MS = 30_000;
private static readonly REINDEX_MAX_LIVE_WAITS = 20; // ~10 min cap, then bail + retry next launch
private static readonly REINDEX_DRAIN_POLL_MS = 2_000;
private static readonly REINDEX_MAX_DRAIN_POLLS = 900; // ~30 min cap on progress polling
scheduleAutoReindex(): void {
const activeSpace = this.embeddingPipeline.getActiveSpaceKey();
if (!activeSpace) return;
if (this.vectorStore.getIncompatibleSpaceCount(activeSpace) === 0) return;
// Defer the kickoff so launch isn't slowed; _runReindex owns the in-flight guard.
// Track the timer so a re-init (settings change) doesn't stack duplicate timers
// and so it can be cancelled on teardown.
if (this._autoReindexTimer) clearTimeout(this._autoReindexTimer);
this._autoReindexTimer = setTimeout(() => {
this._autoReindexTimer = null;
this._runReindex().catch(err => {
console.error('[RAGManager] Auto-reindex failed (will retry next launch):', err);
});
}, RAGManager.AUTO_REINDEX_DEFER_MS);
}
/** Cancel any pending deferred auto-reindex (call on teardown/quit). */
cancelPendingReindex(): void {
if (this._autoReindexTimer) {
clearTimeout(this._autoReindexTimer);
this._autoReindexTimer = null;
}
}
/**
* Teardown hook for app shutdown: cancels the deferred auto-reindex timer (which
* could otherwise fire up to ~15s — or the ~30min drain poll — after quit) and
* terminates the VectorStore worker thread. Call from the before-quit handler.
*/
async dispose(): Promise<void> {
this.cancelPendingReindex();
// Stop the embedding drain loop BEFORE the shared DB handle is closed
// (main.ts disposes RAG, then closes the DB): an in-flight embed that
// resumed after close used to throw into queueMeeting's catch, and on
// the emergency-close path its write raced an uncheckpointed database.
try { this.embeddingPipeline.stop(); } catch { /* non-fatal */ }
try { await this.vectorStore.destroy(); } catch (e) {
console.warn('[RAGManager] dispose: vectorStore.destroy failed (non-fatal):', e);
}
}
/** Shared guarded re-index routine for both the auto and manual paths. */
private async _runReindex(): Promise<void> {
if (this._reindexInFlight) {
console.log('[RAGManager] Re-index already in flight — skipping duplicate trigger.');
return;
}
const activeSpace = this.embeddingPipeline.getActiveSpaceKey();
if (!activeSpace) {
console.error('[RAGManager] Cannot re-index: no active embedding provider.');
return;
}
const count = this.vectorStore.getIncompatibleSpaceCount(activeSpace);
if (count === 0) {
console.log('[RAGManager] No incompatible meetings to re-index.');
return;
}
this._reindexInFlight = true;
this._emitReindex('embedding:reindex-started', { count, space: activeSpace });
console.log(`[RAGManager] Re-indexing ${count} meeting(s) into space ${activeSpace}...`);
try {
// ── Phase 1: requeue ── snapshot the worklist; clear+queue each meeting atomically.
const meetingIds = this.vectorStore.getMeetingIdsNeedingReindex(activeSpace);
const total = meetingIds.length;
for (const meetingId of meetingIds) {
// Pause (capped) if a live meeting is indexing — live work has priority.
let waits = 0;
while (this.liveIndexer.isRunning()) {
if (waits >= RAGManager.REINDEX_MAX_LIVE_WAITS) {
console.warn(`[RAGManager] Re-index pausing exceeded cap (${RAGManager.REINDEX_MAX_LIVE_WAITS} waits) due to continuous live meetings. Bailing; will resume next launch.`);
// Bail cleanly so the toast resolves; the count-based trigger
// re-fires next launch for whatever remains.
this._emitReindex('embedding:reindex-complete', { total, space: activeSpace, partial: true });
return;
}
waits++;
await new Promise(r => setTimeout(r, RAGManager.REINDEX_LIVE_RECHECK_MS));
}
// Atomic clear + enqueue (crash-safe — see requeueMeetingForReindex).
await this.embeddingPipeline.requeueMeetingForReindex(meetingId);
}
console.log(`[RAGManager] Re-index: requeued ${total} meeting(s). Awaiting background embedding...`);
// ── Phase 2: await actual embedding ── the requeue above only QUEUED the work;
// the meetings have NULL embeddings (excluded from search) until the background
// processQueue drains. Report TRUE progress off the queue depth so the UI doesn't
// claim "complete" while past meetings are still unsearchable.
const initialPending = this.embeddingPipeline.getQueueStatus().pending;
let polls = 0;
while (polls < RAGManager.REINDEX_MAX_DRAIN_POLLS) {
const { pending } = this.embeddingPipeline.getQueueStatus();
const doneItems = Math.max(0, initialPending - pending);
this._emitReindex('embedding:reindex-progress', { done: doneItems, total: initialPending, space: activeSpace });
if (pending === 0) break;
polls++;
await new Promise(r => setTimeout(r, RAGManager.REINDEX_DRAIN_POLL_MS));
}
const stillPending = this.embeddingPipeline.getQueueStatus().pending;
// Complete = queue fully drained. If we hit the poll cap with work left
// (very large corpus / slow API), report partial — it keeps draining in the
// background and the count-based trigger re-verifies next launch.
this._emitReindex('embedding:reindex-complete', {
total,
space: activeSpace,
partial: stillPending > 0,
});
console.log(`[RAGManager] Re-index ${stillPending > 0 ? 'partially ' : ''}complete (${stillPending} queue item(s) still pending).`);
} finally {
this._reindexInFlight = false;
}
}
private _emitReindex(channel: string, payload: Record<string, unknown>): void {
try {
const { BrowserWindow } = require('electron');
BrowserWindow.getAllWindows().forEach((win: any) => {
if (!win.isDestroyed()) win.webContents.send(channel, payload);
});
} catch (_) { /* non-fatal — renderer may not be up yet */ }
}
}
