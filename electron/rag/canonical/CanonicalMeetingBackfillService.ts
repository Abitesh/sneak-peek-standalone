/**
 * Change 25 — Step 3.3
 * Historical Meeting searchable-RAG backfill coordinator.
 *
 * Only persisted transcript-derived `chunks` are projected into canonical
 * RAG. Meeting lifecycle data, raw transcripts, summaries, AI interactions,
 * queues, and legacy indexes remain outside this migration boundary.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { CanonicalRagIndexer, type CanonicalIndexRunResult } from './CanonicalRagIndexer';
import { CanonicalRagStorage } from './CanonicalRagStorage';
import type { CanonicalChunkInput } from './CanonicalRagTypes';
import type { MeetingStorageContract } from '../storage/MeetingStorageContract';

const EXTRACTION_VERSION = 'meeting-legacy-unknown-v1';
const CHUNKING_VERSION = 'meeting-legacy-chunk-projection-v1';
const NORMALIZATION_VERSION = 'meeting-legacy-unknown-v1';

export interface MeetingBackfillResult {
  meetingId: string;
  documentId: string;
  revisionId: string;
  chunkCount: number;
  embeddingSpaceId: string;
  complete: boolean;
  activated: boolean;
}

export interface MeetingBackfillSummary {
  attempted: number;
  completed: number;
  failed: number;
  results: MeetingBackfillResult[];
  errors: Array<{ meetingId: string; error: string }>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function corpusHash(chunks: readonly ReturnType<MeetingStorageContract['readChunks']>[number][]): string {
  const representation = chunks.map((chunk) => ({
    chunkIndex: chunk.chunkIndex,
    text: chunk.text,
    speaker: chunk.speaker ?? null,
    timestampStart: chunk.timestampStart ?? null,
    timestampEnd: chunk.timestampEnd ?? null,
    tokenCount: chunk.metadata?.tokenCount ?? null,
  }));
  return sha256(JSON.stringify(representation));
}

function parseTokenCount(metadata: Record<string, unknown>): number | null {
  const value = metadata.tokenCount;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Projects the persisted Meeting searchable transcript corpus into canonical
 * RAG and delegates indexing to the universal CanonicalRagIndexer.
 *
 * The supplied Database handle is used only to enumerate eligible meetings.
 * Legacy meeting rows are never written by this service.
 */
export class CanonicalMeetingBackfillService {
  constructor(
    private readonly db: Database.Database,
    private readonly meetingStorage: MeetingStorageContract,
    private readonly storage: CanonicalRagStorage,
    private readonly indexerFactory: (storage: CanonicalRagStorage) => CanonicalRagIndexer,
  ) {}

  listEligibleMeetingIds(): string[] {
    const rows = this.db.prepare(`
      SELECT m.id
      FROM meetings m
      WHERE m.id != 'live-meeting-current'
        AND COALESCE(m.is_processed, 0) = 1
        AND EXISTS (
          SELECT 1 FROM chunks c WHERE c.meeting_id = m.id
        )
      ORDER BY m.created_at ASC, m.id ASC
    `).all() as Array<{ id: string }>;
    return rows.map((row) => String(row.id));
  }

  async backfillAll(meetingIds: readonly string[] = this.listEligibleMeetingIds()): Promise<MeetingBackfillSummary> {
    const results: MeetingBackfillResult[] = [];
    const errors: Array<{ meetingId: string; error: string }> = [];

    for (const meetingId of meetingIds) {
      try {
        results.push(await this.backfillMeeting(meetingId));
      } catch (error) {
        errors.push({
          meetingId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      attempted: results.length + errors.length,
      completed: results.filter((result) => result.complete).length,
      failed: errors.length + results.filter((result) => !result.complete).length,
      results,
      errors,
    };
  }

  async backfillMeeting(meetingId: string): Promise<MeetingBackfillResult> {
    if (meetingId === 'live-meeting-current') {
      throw new Error('Live meeting cannot be historically backfilled');
    }

    const meeting = this.meetingStorage.readMeeting(meetingId);
    if (!meeting) throw new Error(`Meeting not found: ${meetingId}`);

    const chunks = this.meetingStorage.readChunks(meetingId);
    if (chunks.length === 0) {
      throw new Error(`Meeting ${meetingId} has no persisted searchable RAG chunks`);
    }

    const contentHash = corpusHash(chunks);
    const document = this.storage.createDocument({
      sourceType: 'meeting',
      sourceId: meetingId,
      name: meeting.title || meetingId,
      contentHash,
      metadata: {
        migration: 'change25-step3.3',
        legacyMeetingId: meetingId,
        searchableProjection: 'transcript-chunks',
        startTime: meeting.startTime ?? null,
        durationMs: meeting.durationMs ?? null,
        source: meeting.source ?? null,
        createdAt: meeting.createdAt ?? null,
      },
    });

    this.storage.updateDocument(document.id, {
      name: meeting.title || meetingId,
      contentHash,
      metadata: {
        ...document.metadata,
        migration: 'change25-step3.3',
        legacyMeetingId: meetingId,
        searchableProjection: 'transcript-chunks',
        startTime: meeting.startTime ?? null,
        durationMs: meeting.durationMs ?? null,
        source: meeting.source ?? null,
        createdAt: meeting.createdAt ?? null,
      },
    });

    const revision = this.storage.createRevision({
      documentId: document.id,
      contentHash,
      extractionVersion: EXTRACTION_VERSION,
      chunkingVersion: CHUNKING_VERSION,
      normalizationVersion: NORMALIZATION_VERSION,
      extractionState: 'EXTRACTED',
      metadata: {
        migration: 'change25-step3.3',
        legacyMeetingId: meetingId,
        searchableProjection: 'transcript-chunks',
        legacyRevisionHistoryAvailable: false,
      },
    });

    const canonicalChunks: CanonicalChunkInput[] = chunks.map((chunk) => ({
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      speaker: chunk.speaker ?? null,
      timestampStart: chunk.timestampStart ?? null,
      timestampEnd: chunk.timestampEnd ?? null,
      tokenCount: parseTokenCount(chunk.metadata ?? {}),
      contentType: 'meeting-transcript-chunk',
      sourceLocator: `legacy-meeting:${meetingId}:chunk:${chunk.id}`,
      metadata: {
        ...(chunk.metadata ?? {}),
        legacyChunkId: chunk.id,
        legacyMeetingId: meetingId,
        searchableProjection: 'transcript-chunk',
      },
    }));

    const existingChunks = this.storage.readChunks(revision.id);
    if (existingChunks.length === 0) {
      this.storage.replaceChunks(document.id, revision.id, canonicalChunks);
    } else if (!this.sameChunks(existingChunks, canonicalChunks)) {
      throw new Error(`Canonical revision already exists with different Meeting chunks: ${revision.id}`);
    }

    const indexer = this.indexerFactory(this.storage);
    const indexed = await this.indexerResult(indexer, revision.id);

    return {
      meetingId,
      documentId: indexed.documentId,
      revisionId: indexed.revisionId,
      chunkCount: indexed.chunkCount,
      embeddingSpaceId: indexed.embeddingSpaceId,
      complete: indexed.complete,
      activated: indexed.activated,
    };
  }

  private sameChunks(
    existing: ReturnType<CanonicalRagStorage['readChunks']>,
    expected: readonly CanonicalChunkInput[],
  ): boolean {
    if (existing.length !== expected.length) return false;
    return existing.every((chunk, index) => {
      const candidate = expected[index];
      return chunk.chunkIndex === candidate.chunkIndex
        && chunk.text === candidate.text
        && chunk.speaker === (candidate.speaker ?? null)
        && chunk.timestampStart === (candidate.timestampStart ?? null)
        && chunk.timestampEnd === (candidate.timestampEnd ?? null)
        && chunk.tokenCount === (candidate.tokenCount ?? null);
    });
  }

  private async indexerResult(indexer: CanonicalRagIndexer, revisionId: string): Promise<CanonicalIndexRunResult> {
    return indexer.indexRevision(revisionId, { activate: true });
  }
}
