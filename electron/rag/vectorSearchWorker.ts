// electron/rag/vectorSearchWorker.ts
// Worker thread for offloading cosine similarity computation from the main thread.
// Receives raw Float32 embedding blobs to avoid serialization overhead.

import { parentPort } from 'worker_threads';

interface SearchChunksMessage {
    type: 'searchChunks';
    requestId: number;
    queryEmbedding: Float32Array;  // Transferred, not copied
    rowCount: number;
    embeddingDim: number;
    embeddings: Float32Array;      // Flat buffer: N rows × D dims, transferred
    rowMeta: Array<{               // Lightweight metadata (no embedding copy)
        id: number;
        meeting_id: string;
        chunk_index: number;
        speaker: string;
        start_timestamp_ms: number;
        end_timestamp_ms: number;
        cleaned_text: string;
        token_count: number;
    }>;
    minSimilarity: number;
    limit: number;
}

interface SearchSummariesMessage {
    type: 'searchSummaries';
    requestId: number;
    queryEmbedding: Float32Array;
    rowCount: number;
    embeddingDim: number;
    embeddings: Float32Array;
    rowMeta: Array<{
        id: number;
        meeting_id: string;
        summary_text: string;
    }>;
    limit: number;
}

type WorkerMessage = SearchChunksMessage | SearchSummariesMessage;

// ============================================
// Math helpers — operates directly on Float32Array slices
// ============================================

function cosineSimilarityF32(
    a: Float32Array,
    b: Float32Array,
    bOffset: number,
    dim: number
): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < dim; i++) {
        const ai = a[i];
        const bi = b[bOffset + i];
        dotProduct += ai * bi;
        normA += ai * ai;
        normB += bi * bi;
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
}

// ============================================
// Message handler
// ============================================

if (!parentPort) {
    throw new Error('vectorSearchWorker must be run as a worker_threads Worker');
}

parentPort.on('message', (message: WorkerMessage) => {
    try {
        switch (message.type) {
            case 'searchChunks': {
                const { requestId, queryEmbedding, embeddings, embeddingDim, rowMeta, minSimilarity, limit } = message;
                const scored: Array<{
                    id: number;
                    meetingId: string;
                    chunkIndex: number;
                    speaker: string;
                    startMs: number;
                    endMs: number;
                    text: string;
                    tokenCount: number;
                    similarity: number;
                }> = [];

                for (let i = 0; i < rowMeta.length; i++) {
                    const similarity = cosineSimilarityF32(queryEmbedding, embeddings, i * embeddingDim, embeddingDim);
                    if (similarity >= minSimilarity) {
                        const meta = rowMeta[i];
                        scored.push({
                            id: meta.id,
                            meetingId: meta.meeting_id,
                            chunkIndex: meta.chunk_index,
                            speaker: meta.speaker,
                            startMs: meta.start_timestamp_ms,
                            endMs: meta.end_timestamp_ms,
                            text: meta.cleaned_text,
                            tokenCount: meta.token_count,
                            similarity
                        });
                    }
                }

                scored.sort((a, b) => b.similarity - a.similarity);
                parentPort!.postMessage({
                    type: 'result',
                    requestId,
                    data: scored.slice(0, limit)
                });
                break;
            }

            case 'searchSummaries': {
                const { requestId, queryEmbedding, embeddings, embeddingDim, rowMeta, limit } = message;
                const scored: Array<{
                    meetingId: string;
                    summaryText: string;
                    similarity: number;
                }> = [];

                for (let i = 0; i < rowMeta.length; i++) {
                    const similarity = cosineSimilarityF32(queryEmbedding, embeddings, i * embeddingDim, embeddingDim);
                    const meta = rowMeta[i];
                    scored.push({
                        meetingId: meta.meeting_id,
                        summaryText: meta.summary_text,
                        similarity
                    });
                }

                scored.sort((a, b) => b.similarity - a.similarity);
                parentPort!.postMessage({
                    type: 'result',
                    requestId,
                    data: scored.slice(0, limit)
                });
                break;
            }

            default:
                parentPort!.postMessage({
                    type: 'error',
                    requestId: (message as any).requestId,
                    error: `Unknown message type: ${(message as any).type}`
                });
        }
    } catch (error: any) {
        parentPort!.postMessage({
            type: 'error',
            requestId: (message as any).requestId,
            error: error.message
        });
    }
});
