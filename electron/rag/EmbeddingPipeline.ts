// electron/rag/EmbeddingPipeline.ts
// Post-meeting embedding generation with queue-based retry logic
// Uses Gemini text-embedding-004 (768 dimensions)

import { GoogleGenAI } from '@google/genai';
import Database from 'better-sqlite3';
import { VectorStore, StoredChunk } from './VectorStore';

const EMBEDDING_MODEL = 'text-embedding-004';
const MAX_RETRIES = 3;
const RETRY_DELAY_BASE_MS = 2000;

export interface EmbeddingConfig {
    apiKey: string;
}

/**
 * EmbeddingPipeline - Handles post-meeting embedding generation
 * 
 * Design:
 * - NOT real-time: embeddings generated after meeting ends
 * - Queue-based: persists in SQLite for retry on failure
 * - Background processing: doesn't block UI
 */
export class EmbeddingPipeline {
    private client: GoogleGenAI | null = null;
    private db: Database.Database;
    private vectorStore: VectorStore;
    private isProcessing = false;

    constructor(db: Database.Database, vectorStore: VectorStore) {
        this.db = db;
        this.vectorStore = vectorStore;
    }

    /**
     * Initialize with API key
     */
    initialize(apiKey: string): void {
        if (!apiKey) {
            console.log('[EmbeddingPipeline] No API key provided, embeddings disabled');
            return;
        }
        this.client = new GoogleGenAI({ apiKey });
        console.log('[EmbeddingPipeline] Initialized with Gemini embedding model');
    }

    /**
     * Check if pipeline is ready
     */
    isReady(): boolean {
        return this.client !== null;
    }

    /**
     * Queue a meeting for embedding processing
     * Called when meeting ends
     */
    async queueMeeting(meetingId: string): Promise<void> {
        // Get chunks without embeddings
        const chunks = this.vectorStore.getChunksWithoutEmbeddings(meetingId);

        if (chunks.length === 0) {
            console.log(`[EmbeddingPipeline] No chunks to embed for meeting ${meetingId}`);
            return;
        }

        // Queue each chunk
        const insert = this.db.prepare(`
            INSERT INTO embedding_queue (meeting_id, chunk_id, status)
            VALUES (?, ?, 'pending')
        `);

        const queueAll = this.db.transaction(() => {
            for (const chunk of chunks) {
                insert.run(meetingId, chunk.id);
            }
            // Also queue summary (chunk_id = NULL means summary)
            insert.run(meetingId, null);
        });

        queueAll();
        console.log(`[EmbeddingPipeline] Queued ${chunks.length} chunks + 1 summary for meeting ${meetingId}`);

        // Start processing in background
        this.processQueue().catch(err => {
            console.error('[EmbeddingPipeline] Queue processing error:', err);
        });
    }

    /**
     * Process pending embeddings from queue
     */
    async processQueue(): Promise<void> {
        if (this.isProcessing) {
            console.log('[EmbeddingPipeline] Already processing queue');
            return;
        }

        if (!this.client) {
            console.log('[EmbeddingPipeline] No client, skipping queue processing');
            return;
        }

        this.isProcessing = true;

        try {
            while (true) {
                // Get next pending item
                const pending = this.db.prepare(`
                    SELECT * FROM embedding_queue 
                    WHERE status = 'pending' AND retry_count < ?
                    ORDER BY created_at ASC
                    LIMIT 1
                `).get(MAX_RETRIES) as any;

                if (!pending) {
                    console.log('[EmbeddingPipeline] Queue empty');
                    break;
                }

                // Mark as processing
                this.db.prepare(
                    `UPDATE embedding_queue SET status = 'processing' WHERE id = ?`
                ).run(pending.id);

                try {
                    if (pending.chunk_id) {
                        await this.embedChunk(pending.chunk_id);
                    } else {
                        await this.embedMeetingSummary(pending.meeting_id);
                    }

                    // Mark as completed
                    this.db.prepare(`
                        UPDATE embedding_queue 
                        SET status = 'completed', processed_at = ?
                        WHERE id = ?
                    `).run(new Date().toISOString(), pending.id);

                } catch (error: any) {
                    console.error(`[EmbeddingPipeline] Error processing queue item ${pending.id}:`, error.message);

                    // Update retry count and status
                    this.db.prepare(`
                        UPDATE embedding_queue 
                        SET status = 'pending', retry_count = retry_count + 1, error_message = ?
                        WHERE id = ?
                    `).run(error.message, pending.id);

                    // Exponential backoff
                    const delay = RETRY_DELAY_BASE_MS * Math.pow(2, pending.retry_count);
                    await this.delay(delay);
                }
            }
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Get embedding for text using Gemini
     */
    async getEmbedding(text: string): Promise<number[]> {
        if (!this.client) {
            throw new Error('Embedding client not initialized');
        }

        const result = await this.client.models.embedContent({
            model: EMBEDDING_MODEL,
            contents: [{ parts: [{ text }] }]
        });

        if (!result.embeddings || !result.embeddings[0]) {
            throw new Error('No embedding returned from API');
        }

        return result.embeddings[0].values as number[];
    }

    /**
     * Embed a single chunk
     */
    private async embedChunk(chunkId: number): Promise<void> {
        // Get chunk text
        const row = this.db.prepare('SELECT cleaned_text FROM chunks WHERE id = ?').get(chunkId) as any;
        if (!row) {
            console.log(`[EmbeddingPipeline] Chunk ${chunkId} not found, skipping`);
            return;
        }

        const embedding = await this.getEmbedding(row.cleaned_text);
        this.vectorStore.storeEmbedding(chunkId, embedding);

        console.log(`[EmbeddingPipeline] Embedded chunk ${chunkId}`);
    }

    /**
     * Embed meeting summary
     */
    private async embedMeetingSummary(meetingId: string): Promise<void> {
        // Get summary text
        const row = this.db.prepare(
            'SELECT summary_text FROM chunk_summaries WHERE meeting_id = ?'
        ).get(meetingId) as any;

        if (!row) {
            console.log(`[EmbeddingPipeline] No summary for meeting ${meetingId}, skipping`);
            return;
        }

        const embedding = await this.getEmbedding(row.summary_text);
        this.vectorStore.storeSummaryEmbedding(meetingId, embedding);

        console.log(`[EmbeddingPipeline] Embedded summary for meeting ${meetingId}`);
    }

    /**
     * Get queue status
     */
    getQueueStatus(): { pending: number; processing: number; completed: number; failed: number } {
        const counts = this.db.prepare(`
            SELECT status, COUNT(*) as count FROM embedding_queue GROUP BY status
        `).all() as any[];

        const result = { pending: 0, processing: 0, completed: 0, failed: 0 };

        for (const row of counts) {
            if (row.status === 'pending') result.pending = row.count;
            else if (row.status === 'processing') result.processing = row.count;
            else if (row.status === 'completed') result.completed = row.count;
            else if (row.status === 'failed') result.failed = row.count;
        }

        // Count failed (retry_count >= MAX_RETRIES)
        const failed = this.db.prepare(`
            SELECT COUNT(*) as count FROM embedding_queue 
            WHERE retry_count >= ? AND status = 'pending'
        `).get(MAX_RETRIES) as any;

        result.failed = failed.count;

        return result;
    }

    /**
     * Clear completed queue items older than N days
     */
    cleanupQueue(daysOld: number = 7): void {
        const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
        this.db.prepare(`
            DELETE FROM embedding_queue 
            WHERE status = 'completed' AND processed_at < ?
        `).run(cutoff);
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
