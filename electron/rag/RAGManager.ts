// electron/rag/RAGManager.ts
// Central orchestrator for RAG pipeline
// Coordinates preprocessing, chunking, embedding, and retrieval

import Database from 'better-sqlite3';
import { LLMHelper } from '../LLMHelper';
import { preprocessTranscript, RawSegment } from './TranscriptPreprocessor';
import { chunkTranscript } from './SemanticChunker';
import { VectorStore } from './VectorStore';
import { EmbeddingPipeline } from './EmbeddingPipeline';
import { RAGRetriever } from './RAGRetriever';
import { buildRAGPrompt, NO_CONTEXT_FALLBACK, NO_GLOBAL_CONTEXT_FALLBACK } from './prompts';

export interface RAGManagerConfig {
    db: Database.Database;
    apiKey?: string;
}

/**
 * RAGManager - Central orchestrator for RAG operations
 * 
 * Lifecycle:
 * 1. Initialize with database and API key
 * 2. When meeting ends: processMeeting() -> chunks + queue embeddings
 * 3. When user queries: query() -> retrieve + stream response
 */
export class RAGManager {
    private db: Database.Database;
    private vectorStore: VectorStore;
    private embeddingPipeline: EmbeddingPipeline;
    private retriever: RAGRetriever;
    private llmHelper: LLMHelper | null = null;

    constructor(config: RAGManagerConfig) {
        this.db = config.db;
        this.vectorStore = new VectorStore(config.db);
        this.embeddingPipeline = new EmbeddingPipeline(config.db, this.vectorStore);
        this.retriever = new RAGRetriever(this.vectorStore, this.embeddingPipeline);

        if (config.apiKey) {
            this.embeddingPipeline.initialize(config.apiKey);
        }
    }

    /**
     * Set LLM helper for generating responses
     */
    setLLMHelper(llmHelper: LLMHelper): void {
        this.llmHelper = llmHelper;
    }

    /**
     * Initialize embedding pipeline with API key
     */
    initializeEmbeddings(apiKey: string): void {
        this.embeddingPipeline.initialize(apiKey);
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

        // Check if meeting has embeddings
        const hasEmbeddings = this.vectorStore.hasEmbeddings(meetingId);

        if (!hasEmbeddings) {
            // Fallback: no embeddings available yet - trigger wrapper fallback
            throw new Error('NO_MEETING_EMBEDDINGS');
        }

        // Retrieve relevant context
        const context = await this.retriever.retrieve(query, { meetingId });

        if (context.chunks.length === 0) {
            // No context relevant to query - trigger wrapper fallback to use context window
            throw new Error('NO_RELEVANT_CONTEXT_FOUND');
        }

        // Build prompt with intent hint
        const prompt = buildRAGPrompt(query, context.formattedContext, 'meeting', context.intent);

        // Stream response
        const stream = this.llmHelper.streamChatWithGemini(prompt, undefined, undefined, true);

        for await (const chunk of stream) {
            if (abortSignal?.aborted) break;
            yield chunk;
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

        // Retrieve from all meetings
        const context = await this.retriever.retrieveGlobal(query);

        if (context.chunks.length === 0) {
            yield NO_GLOBAL_CONTEXT_FALLBACK;
            return;
        }

        // Build prompt with intent hint
        const prompt = buildRAGPrompt(query, context.formattedContext, 'global', context.intent);

        // Stream response
        const stream = this.llmHelper.streamChatWithGemini(prompt, undefined, undefined, true);

        for await (const chunk of stream) {
            if (abortSignal?.aborted) break;
            yield chunk;
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

    /**
     * Delete RAG data for a meeting
     */
    deleteMeetingData(meetingId: string): void {
        this.vectorStore.deleteChunksForMeeting(meetingId);
    }

    /**
     * Manually trigger processing for a meeting
     * Useful for demo meetings or reprocessing failed ones
     */
    async reprocessMeeting(meetingId: string): Promise<void> {
        console.log(`[RAGManager] Reprocessing meeting ${meetingId}`);

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
    }

    /**
     * Ensure demo meeting is processed
     * Checks if demo meeting exists but has no chunks, then processes it
     */
    async ensureDemoMeetingProcessed(): Promise<void> {
        const demoId = 'demo-meeting-004';

        // Check if demo meeting exists in DB
        const { DatabaseManager } = require('../db/DatabaseManager');
        const meeting = DatabaseManager.getInstance().getMeetingDetails(demoId);

        if (!meeting) return; // No demo meeting, nothing to do

        // Check if already processed
        if (this.isMeetingProcessed(demoId)) {
            // console.log('[RAGManager] Demo meeting already processed');
            return;
        }

        console.log('[RAGManager] Demo meeting found but not processed. Processing now...');
        await this.reprocessMeeting(demoId);
    }
}
