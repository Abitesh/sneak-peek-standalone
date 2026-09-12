// electron/rag/storage/MeetingStorageTypes.ts
//
// Change 25 — Slice 3B.2
// Semantic storage types for the existing meeting aggregate.
//
// This module describes the existing physical meeting persistence model at
// the storage boundary. It does not introduce a new database schema.

import type { RagChunk, StoredRagEmbedding } from './RagStorageTypes';

export interface MeetingStorageRecord {
  id: string;
  title: string;
  startTime?: number;
  durationMs?: number;
  summaryJson?: string;
  createdAt?: string;
  calendarEventId?: string;
  source?: string;
  isProcessed?: boolean;
  summaryStatus?: string;
  userTitled?: boolean;
  embeddingProvider?: string;
  embeddingDimensions?: number;
  embeddingSpace?: string;
}

export interface MeetingTranscriptRecord {
  id?: number;
  meetingId: string;
  speaker: string;
  content: string;
  timestampMs: number;
}

export interface MeetingSearchableSummary {
  id?: number;
  meetingId: string;
  summaryText: string;
  createdAt?: string;
}

export type MeetingEmbeddingTarget = 'chunk' | 'summary';

export interface MeetingStorageEmbedding {
  target: MeetingEmbeddingTarget;
  embedding: StoredRagEmbedding;
}

export type MeetingStorageChunk = RagChunk;

export interface MeetingChunkIdMapping {
  canonicalId: string;
  physicalId: string;
}
