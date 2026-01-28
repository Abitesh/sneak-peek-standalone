// electron/rag/SemanticChunker.ts
// Turn-based semantic chunking for RAG
// Chunks by speaker turns, respects token limits

import { CleanedSegment, estimateTokens } from './TranscriptPreprocessor';

export interface Chunk {
    meetingId: string;
    chunkIndex: number;
    speaker: string;
    startMs: number;
    endMs: number;
    text: string;
    tokenCount: number;
}

// Chunking parameters
const TARGET_TOKENS = 300;
const MAX_TOKENS = 400;
const MIN_TOKENS = 100;

/**
 * Build a chunk from accumulated segments
 */
function buildChunk(
    meetingId: string,
    index: number,
    segments: CleanedSegment[]
): Chunk {
    const text = segments.map(s => s.text).join(' ');
    return {
        meetingId,
        chunkIndex: index,
        speaker: segments[0].speaker,
        startMs: segments[0].startMs,
        endMs: segments[segments.length - 1].endMs,
        text,
        tokenCount: estimateTokens(text)
    };
}

/**
 * Semantic chunking algorithm
 * 
 * Strategy:
 * 1. Group by speaker turns (natural conversation boundaries)
 * 2. Merge short consecutive turns from same speaker
 * 3. Split if exceeding token limit
 * 4. Target 200-400 tokens per chunk
 * 
 * Why this works:
 * - Turn-based chunking preserves conversational context
 * - Speaker metadata enables filtering ("what did X say?")
 * - Token limits ensure embedding quality and retrieval precision
 */
export function chunkTranscript(
    meetingId: string,
    segments: CleanedSegment[]
): Chunk[] {
    if (segments.length === 0) return [];

    const chunks: Chunk[] = [];
    let currentChunk: CleanedSegment[] = [];
    let currentTokens = 0;
    let chunkIndex = 0;

    for (const seg of segments) {
        const segTokens = estimateTokens(seg.text);

        // Decide whether to start a new chunk
        const shouldSplit =
            // Speaker changed and we have content
            (currentChunk.length > 0 && seg.speaker !== currentChunk[0].speaker) ||
            // Would exceed max tokens and we have minimum content
            (currentTokens + segTokens > MAX_TOKENS && currentTokens >= MIN_TOKENS);

        if (shouldSplit && currentChunk.length > 0) {
            chunks.push(buildChunk(meetingId, chunkIndex++, currentChunk));
            currentChunk = [];
            currentTokens = 0;
        }

        currentChunk.push(seg);
        currentTokens += segTokens;

        // Force split if single segment exceeds max (rare edge case)
        if (currentTokens > MAX_TOKENS && currentChunk.length === 1) {
            chunks.push(buildChunk(meetingId, chunkIndex++, currentChunk));
            currentChunk = [];
            currentTokens = 0;
        }
    }

    // Flush remaining segments
    if (currentChunk.length > 0) {
        chunks.push(buildChunk(meetingId, chunkIndex++, currentChunk));
    }

    return chunks;
}

/**
 * Format chunks for display in context
 */
export function formatChunkForContext(chunk: Chunk): string {
    const minutes = Math.floor(chunk.startMs / 60000);
    const seconds = Math.floor((chunk.startMs % 60000) / 1000);
    const timestamp = `${minutes}:${seconds.toString().padStart(2, '0')}`;

    return `[${timestamp}] ${chunk.speaker}: ${chunk.text}`;
}
