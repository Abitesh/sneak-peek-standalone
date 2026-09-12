// electron/rag/storage/MeetingStorageContract.ts

import type {
  MeetingChunkIdMapping,
  MeetingSearchableSummary,
  MeetingStorageChunk,
  MeetingStorageEmbedding,
  MeetingStorageRecord,
  MeetingTranscriptRecord,
} from './MeetingStorageTypes';

export type {
  MeetingChunkIdMapping,
  MeetingSearchableSummary,
  MeetingStorageChunk,
  MeetingStorageEmbedding,
  MeetingStorageRecord,
  MeetingTranscriptRecord,
} from './MeetingStorageTypes';

export interface MeetingStorageContract {
  readMeeting(meetingId: string): MeetingStorageRecord | null;
  readTranscript(meetingId: string): MeetingTranscriptRecord[];
  readChunks(meetingId: string): MeetingStorageChunk[];
  readSearchableSummary(meetingId: string): MeetingSearchableSummary | null;

  replaceTranscript(
    meetingId: string,
    transcript: readonly MeetingTranscriptRecord[],
  ): void;

  replaceChunks(
    meetingId: string,
    chunks: readonly MeetingStorageChunk[],
  ): MeetingChunkIdMapping[];

  writeSearchableSummary(meetingId: string, summaryText: string): void;

  clearEmbeddings(meetingId: string): void;

  storeChunkEmbedding(
    physicalChunkId: string,
    embedding: MeetingStorageEmbedding & { target: 'chunk' },
  ): void;

  storeSummaryEmbedding(
    meetingId: string,
    embedding: MeetingStorageEmbedding & { target: 'summary' },
  ): void;

  deleteMeetingIndex(meetingId: string): void;
  deleteMeeting(meetingId: string): boolean;
}
