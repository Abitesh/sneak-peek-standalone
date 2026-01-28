// electron/rag/VectorStore.ts
// SQLite-based vector storage with pure JS cosine similarity
// No native dependencies - works offline

import Database from 'better-sqlite3';
import { Chunk } from './SemanticChunker';

export interface StoredChunk extends Chunk {
    id: number;
    embedding?: number[];
}

export interface ScoredChunk extends StoredChunk {
    similarity: number;
    finalScore?: number;
}

/**
 * VectorStore - SQLite-backed vector storage
 * 
 * Uses binary BLOBs for embedding storage (768 float32s = 3072 bytes)
 * Pure JS cosine similarity for retrieval (fast enough for <10K chunks)
 */
export class VectorStore {
    private db: Database.Database;

    constructor(db: Database.Database) {
        this.db = db;
    }

    /**
     * Save chunks to database (without embeddings)
     */
    saveChunks(chunks: Chunk[]): number[] {
        const insert = this.db.prepare(`
            INSERT INTO chunks (meeting_id, chunk_index, speaker, start_timestamp_ms, end_timestamp_ms, cleaned_text, token_count)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        const ids: number[] = [];

        const insertAll = this.db.transaction(() => {
            for (const chunk of chunks) {
                const result = insert.run(
                    chunk.meetingId,
                    chunk.chunkIndex,
                    chunk.speaker,
                    chunk.startMs,
                    chunk.endMs,
                    chunk.text,
                    chunk.tokenCount
                );
                ids.push(result.lastInsertRowid as number);
            }
        });

        insertAll();
        return ids;
    }

    /**
     * Store embedding for a chunk
     */
    storeEmbedding(chunkId: number, embedding: number[]): void {
        const blob = this.embeddingToBlob(embedding);
        this.db.prepare('UPDATE chunks SET embedding = ? WHERE id = ?').run(blob, chunkId);
    }

    /**
     * Get chunks without embeddings for a meeting
     */
    getChunksWithoutEmbeddings(meetingId: string): StoredChunk[] {
        const rows = this.db.prepare(`
            SELECT * FROM chunks 
            WHERE meeting_id = ? AND embedding IS NULL
            ORDER BY chunk_index ASC
        `).all(meetingId) as any[];

        return rows.map(this.rowToChunk);
    }

    /**
     * Get all chunks for a meeting
     */
    getChunksForMeeting(meetingId: string): StoredChunk[] {
        const rows = this.db.prepare(`
            SELECT * FROM chunks 
            WHERE meeting_id = ?
            ORDER BY chunk_index ASC
        `).all(meetingId) as any[];

        return rows.map(this.rowToChunk);
    }

    /**
     * Search for similar chunks using cosine similarity
     */
    searchSimilar(
        queryEmbedding: number[],
        options: {
            meetingId?: string;
            limit?: number;
            minSimilarity?: number;
        } = {}
    ): ScoredChunk[] {
        const { meetingId, limit = 8, minSimilarity = 0.25 } = options;

        // Build query based on filter
        let query = 'SELECT * FROM chunks WHERE embedding IS NOT NULL';
        const params: any[] = [];

        if (meetingId) {
            query += ' AND meeting_id = ?';
            params.push(meetingId);
        }

        const rows = this.db.prepare(query).all(...params) as any[];

        // Compute similarities in JS (fast for <10K chunks)
        const scored: ScoredChunk[] = [];

        for (const row of rows) {
            const chunkEmbedding = this.blobToEmbedding(row.embedding);
            const similarity = this.cosineSimilarity(queryEmbedding, chunkEmbedding);

            if (similarity >= minSimilarity) {
                scored.push({
                    ...this.rowToChunk(row),
                    embedding: chunkEmbedding,
                    similarity
                });
            }
        }

        // Sort by similarity descending
        scored.sort((a, b) => b.similarity - a.similarity);

        return scored.slice(0, limit);
    }

    /**
     * Delete all chunks for a meeting
     */
    deleteChunksForMeeting(meetingId: string): void {
        this.db.prepare('DELETE FROM chunks WHERE meeting_id = ?').run(meetingId);
    }

    /**
     * Check if meeting has embeddings
     */
    hasEmbeddings(meetingId: string): boolean {
        const row = this.db.prepare(`
            SELECT COUNT(*) as count FROM chunks 
            WHERE meeting_id = ? AND embedding IS NOT NULL
        `).get(meetingId) as any;

        return row.count > 0;
    }

    // ============================================
    // Summary Methods (for global search)
    // ============================================

    /**
     * Save or update meeting summary
     */
    saveSummary(meetingId: string, summaryText: string): void {
        this.db.prepare(`
            INSERT OR REPLACE INTO chunk_summaries (meeting_id, summary_text)
            VALUES (?, ?)
        `).run(meetingId, summaryText);
    }

    /**
     * Store embedding for meeting summary
     */
    storeSummaryEmbedding(meetingId: string, embedding: number[]): void {
        const blob = this.embeddingToBlob(embedding);
        this.db.prepare('UPDATE chunk_summaries SET embedding = ? WHERE meeting_id = ?').run(blob, meetingId);
    }

    /**
     * Search summaries for global queries
     */
    searchSummaries(
        queryEmbedding: number[],
        limit: number = 5
    ): { meetingId: string; summaryText: string; similarity: number }[] {
        const rows = this.db.prepare(`
            SELECT * FROM chunk_summaries WHERE embedding IS NOT NULL
        `).all() as any[];

        const scored: { meetingId: string; summaryText: string; similarity: number }[] = [];

        for (const row of rows) {
            const summaryEmbedding = this.blobToEmbedding(row.embedding);
            const similarity = this.cosineSimilarity(queryEmbedding, summaryEmbedding);

            scored.push({
                meetingId: row.meeting_id,
                summaryText: row.summary_text,
                similarity
            });
        }

        scored.sort((a, b) => b.similarity - a.similarity);
        return scored.slice(0, limit);
    }

    // ============================================
    // Private Helpers
    // ============================================

    private rowToChunk(row: any): StoredChunk {
        return {
            id: row.id,
            meetingId: row.meeting_id,
            chunkIndex: row.chunk_index,
            speaker: row.speaker,
            startMs: row.start_timestamp_ms,
            endMs: row.end_timestamp_ms,
            text: row.cleaned_text,
            tokenCount: row.token_count,
            embedding: row.embedding ? this.blobToEmbedding(row.embedding) : undefined
        };
    }

    /**
     * Convert embedding array to binary BLOB (Float32)
     */
    private embeddingToBlob(embedding: number[]): Buffer {
        const buffer = Buffer.alloc(embedding.length * 4);
        for (let i = 0; i < embedding.length; i++) {
            buffer.writeFloatLE(embedding[i], i * 4);
        }
        return buffer;
    }

    /**
     * Convert binary BLOB back to embedding array
     */
    private blobToEmbedding(blob: Buffer): number[] {
        const embedding: number[] = [];
        for (let i = 0; i < blob.length; i += 4) {
            embedding.push(blob.readFloatLE(i));
        }
        return embedding;
    }

    /**
     * Compute cosine similarity between two vectors
     */
    private cosineSimilarity(a: number[], b: number[]): number {
        if (a.length !== b.length) return 0;

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }

        const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
        return magnitude === 0 ? 0 : dotProduct / magnitude;
    }
}
