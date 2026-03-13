// electron/rag/EmbeddingPipeline.ts
// Post-meeting embedding generation with queue-based retry logic
// Uses pluggable IEmbeddingProvider (Gemini, OpenAI, or Ollama)

import Database from 'better-sqlite3';
import { VectorStore, StoredChunk } from './VectorStore';

import { EmbeddingProviderResolver, AppAPIConfig } from './EmbeddingProviderResolver';
import { IEmbeddingProvider } from './providers/IEmbeddingProvider';

const MAX_RETRIES = 3;
const RETRY_DELAY_BASE_MS = 2000;

/**
 * EmbeddingPipeline - Handles post-meeting embedding generation
 * 
 * Design:
 * - NOT real-time: embeddings generated after meeting ends
 * - Queue-based: persists in SQLite for retry on failure
 * - Background processing: doesn't block UI
 * - Provider-agnostic: works with Gemini, OpenAI, or Ollama embeddings
 */
export class EmbeddingPipeline {
    private provider: IEmbeddingProvider | null = null;
    private db: Database.Database;
    private vectorStore: VectorStore;
    private isProcessing = false;
    private initPromise: Promise<void> | null = null;

    constructor(db: Database.Database, vectorStore: VectorStore) {
        this.db = db;
        this.vectorStore = vectorStore;
    }

    /**
     * Initialize with provider config (picks best available provider)
     */
    async initialize(config: AppAPIConfig): Promise<void> {
        console.log('[EmbeddingPipeline] Initializing with config:', config);
        this.initPromise = this._doInitialize(config);
        return this.initPromise;
    }

    private async _doInitialize(config: AppAPIConfig): Promise<void> {
        try {
            this.provider = await EmbeddingProviderResolver.resolve(config);
            console.log(`[EmbeddingPipeline] Ready with provider: ${this.provider.name} (${this.provider.dimensions}d)`);

            // Check for previous provider mismatches
            const stateRow = this.db.prepare("SELECT value FROM app_state WHERE key = 'last_embedding_provider'").get() as any;
            const lastProvider = stateRow?.value;

            if (lastProvider && lastProvider !== this.provider.name) {
                const count = this.vectorStore.getIncompatibleMeetingsCount(this.provider.name);
                if (count > 0) {
                    console.log(`[EmbeddingPipeline] Found ${count} incompatible meetings from ${lastProvider}.`);
                    const { BrowserWindow } = require('electron');
                    BrowserWindow.getAllWindows().forEach((win: any) => {
                        if (!win.isDestroyed()) {
                            win.webContents.send('embedding:incompatible-provider-warning', {
                                count,
                                oldProvider: lastProvider,
                                newProvider: this.provider!.name
                            });
                        }
                    });
                }
            }

            // Save new provider
            this.db.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES ('last_embedding_provider', ?)").run(this.provider.name);

        } catch (err) {
            console.error('[EmbeddingPipeline] Failed to initialize any provider:', err);
            throw err;
        }
    }

    /**
     * Check if pipeline is ready
     */
    isReady(): boolean {
        return this.provider !== null;
    }

    /**
     * Wait for the pipeline to finish initializing.
     * Safe to call multiple times — resolves immediately if already ready.
     * Throws if initialization failed entirely.
     */
    async waitForReady(timeoutMs: number = 15000): Promise<void> {
        if (this.provider) return; // already ready
        if (this.initPromise) {
            // Race against a timeout so we don't hang forever
            await Promise.race([
                this.initPromise,
                new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error(`Embedding pipeline initialization timed out after ${timeoutMs}ms`)), timeoutMs)
                )
            ]);
            return;
        }
        throw new Error('Embedding pipeline has not been initialized');
    }

    /**
     * Get the currently active provider name (used for dimension safety checks)
     */
    getActiveProviderName(): string | undefined {
        return this.provider?.name;
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
        
        // NOTE: Provider metadata is written on the first successful embedding
        // for this meeting (inside embedChunk), not here — to avoid marking a
        // meeting as embedded if the queue crashes before any work is done.

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

        if (!this.provider) {
            console.log('[EmbeddingPipeline] No provider, skipping queue processing');
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
     * Get embedding for a document chunk (for storage)
     */
    async getEmbedding(text: string): Promise<number[]> {
        if (!this.provider) {
            throw new Error('Embedding provider not initialized');
        }
        return this.provider.embed(text);
    }

    /**
     * Get embedding for a search query (may use different prefix for asymmetric models)
     */
    async getEmbeddingForQuery(text: string): Promise<number[]> {
        if (!this.provider) {
            throw new Error('Embedding provider not initialized');
        }
        return this.provider.embedQuery(text);
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

        // Record provider metadata on the meeting after first successful embedding
        if (this.provider) {
            try {
                const meetingRow = this.db.prepare('SELECT meeting_id FROM chunks WHERE id = ?').get(chunkId) as any;
                if (meetingRow) {
                    this.db.prepare(
                        'UPDATE meetings SET embedding_provider = ?, embedding_dimensions = ? WHERE id = ? AND embedding_provider IS NULL'
                    ).run(this.provider.name, this.provider.dimensions, meetingRow.meeting_id);
                }
            } catch (e) {
                // Non-fatal — metadata is for safety filtering, not critical path
            }
        }

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
