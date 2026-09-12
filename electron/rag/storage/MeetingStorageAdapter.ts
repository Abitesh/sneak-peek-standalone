// electron/rag/storage/MeetingStorageAdapter.ts
//
// Change 25 — Slice 3B.2
// Persistence translation boundary for the existing meeting storage.
//
// No schema migration is introduced here. Existing DatabaseManager and
// VectorStore remain the physical implementations. This adapter does not
// perform retrieval, ranking, prompting, OCR, or UI work.

import type Database from 'better-sqlite3';
import { DatabaseManager } from '../../db/DatabaseManager';
import { VectorStore } from '../VectorStore';
import type {
  MeetingChunkIdMapping,
  MeetingStorageContract,
  MeetingStorageChunk,
  MeetingStorageEmbedding,
  MeetingStorageRecord,
  MeetingSearchableSummary,
  MeetingTranscriptRecord,
} from './MeetingStorageContract';

export class MeetingStorageAdapter implements MeetingStorageContract {
  constructor(
    private readonly db: Database.Database,
    private readonly vectorStore: VectorStore,
  ) {}

  readMeeting(meetingId: string): MeetingStorageRecord | null {
    const row = this.db.prepare(`
      SELECT id, title, start_time, duration_ms, summary_json, created_at,
             calendar_event_id, source, is_processed, summary_status,
             user_titled, embedding_provider, embedding_dimensions,
             embedding_space
      FROM meetings
      WHERE id = ?
      LIMIT 1
    `).get(meetingId) as any;

    if (!row) return null;

    return {
      id: String(row.id),
      title: String(row.title ?? ''),
      startTime: row.start_time == null ? undefined : Number(row.start_time),
      durationMs: row.duration_ms == null ? undefined : Number(row.duration_ms),
      summaryJson: row.summary_json == null ? undefined : String(row.summary_json),
      createdAt: row.created_at == null ? undefined : String(row.created_at),
      calendarEventId: row.calendar_event_id == null ? undefined : String(row.calendar_event_id),
      source: row.source == null ? undefined : String(row.source),
      isProcessed: row.is_processed == null ? undefined : Number(row.is_processed) === 1,
      summaryStatus: row.summary_status == null ? undefined : String(row.summary_status),
      userTitled: row.user_titled == null ? undefined : Number(row.user_titled) === 1,
      embeddingProvider: row.embedding_provider == null ? undefined : String(row.embedding_provider),
      embeddingDimensions: row.embedding_dimensions == null
        ? undefined
        : Number(row.embedding_dimensions),
      embeddingSpace: row.embedding_space == null ? undefined : String(row.embedding_space),
    };
  }

  readTranscript(meetingId: string): MeetingTranscriptRecord[] {
    const rows = this.db.prepare(`
      SELECT id, meeting_id, speaker, content, timestamp_ms
      FROM transcripts
      WHERE meeting_id = ?
      ORDER BY timestamp_ms ASC, id ASC
    `).all(meetingId) as any[];

    return rows.map((row) => ({
      id: Number(row.id),
      meetingId: String(row.meeting_id),
      speaker: String(row.speaker ?? ''),
      content: String(row.content ?? ''),
      timestampMs: Number(row.timestamp_ms ?? 0),
    }));
  }

  readChunks(meetingId: string): MeetingStorageChunk[] {
    const rows = this.db.prepare(`
      SELECT id, meeting_id, chunk_index, speaker,
             start_timestamp_ms, end_timestamp_ms,
             cleaned_text, token_count
      FROM chunks
      WHERE meeting_id = ?
      ORDER BY chunk_index ASC, id ASC
    `).all(meetingId) as any[];

    return rows.map((row) => ({
      id: String(row.id),
      documentId: String(row.meeting_id),
      text: String(row.cleaned_text ?? ''),
      chunkIndex: Number(row.chunk_index),
      speaker: row.speaker == null ? undefined : String(row.speaker),
      timestampStart: row.start_timestamp_ms == null
        ? undefined
        : Number(row.start_timestamp_ms),
      timestampEnd: row.end_timestamp_ms == null
        ? undefined
        : Number(row.end_timestamp_ms),
      metadata: {
        tokenCount: Number(row.token_count ?? 0),
      },
    }));
  }

  readSearchableSummary(meetingId: string): MeetingSearchableSummary | null {
    const row = this.db.prepare(`
      SELECT id, meeting_id, summary_text, created_at
      FROM chunk_summaries
      WHERE meeting_id = ?
      LIMIT 1
    `).get(meetingId) as any;

    if (!row) return null;

    return {
      id: Number(row.id),
      meetingId: String(row.meeting_id),
      summaryText: String(row.summary_text ?? ''),
      createdAt: row.created_at == null ? undefined : String(row.created_at),
    };
  }

  replaceTranscript(
    meetingId: string,
    transcript: readonly MeetingTranscriptRecord[],
  ): void {
    const insert = this.db.prepare(`
      INSERT INTO transcripts (meeting_id, speaker, content, timestamp_ms)
      VALUES (?, ?, ?, ?)
    `);

    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM transcripts WHERE meeting_id = ?').run(meetingId);

      for (const record of transcript) {
        insert.run(
          meetingId,
          record.speaker,
          record.content,
          record.timestampMs,
        );
      }
    });

    tx();
  }

  replaceChunks(
    meetingId: string,
    chunks: readonly MeetingStorageChunk[],
  ): MeetingChunkIdMapping[] {
    const mappings: MeetingChunkIdMapping[] = [];

    const tx = this.db.transaction(() => {
      this.deleteChunkVectors(meetingId);
      this.db.prepare('DELETE FROM chunks WHERE meeting_id = ?').run(meetingId);

      const insert = this.db.prepare(`
        INSERT INTO chunks (
          meeting_id, chunk_index, speaker,
          start_timestamp_ms, end_timestamp_ms,
          cleaned_text, token_count
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const chunk of chunks) {
        const metadata = chunk.metadata ?? {};
        const result = insert.run(
          meetingId,
          chunk.chunkIndex,
          chunk.speaker ?? null,
          chunk.timestampStart ?? null,
          chunk.timestampEnd ?? null,
          chunk.text,
          typeof metadata.tokenCount === 'number' ? metadata.tokenCount : 0,
        );

        mappings.push({
          canonicalId: chunk.id,
          physicalId: String(result.lastInsertRowid),
        });
      }
    });

    tx();

    return mappings;
  }

  writeSearchableSummary(meetingId: string, summaryText: string): void {
    this.vectorStore.saveSummary(meetingId, summaryText);
  }

  clearEmbeddings(meetingId: string): void {
    this.vectorStore.clearEmbeddingsForMeeting(meetingId);
  }

  storeChunkEmbedding(
    physicalChunkId: string,
    embedding: MeetingStorageEmbedding & { target: 'chunk' },
  ): void {
    const physicalId = this.toPhysicalChunkId(physicalChunkId);

    this.vectorStore.storeEmbedding(
      physicalId,
      embedding.embedding.embedding,
    );

    const row = this.db.prepare(
      'SELECT meeting_id FROM chunks WHERE id = ? LIMIT 1'
    ).get(physicalId) as { meeting_id: string } | undefined;

    if (!row) {
      throw new Error(`Meeting chunk not found after embedding write: ${physicalChunkId}`);
    }

    this.updateMeetingEmbeddingMetadata(String(row.meeting_id), embedding);
  }

  storeSummaryEmbedding(
    meetingId: string,
    embedding: MeetingStorageEmbedding & { target: 'summary' },
  ): void {
    this.vectorStore.storeSummaryEmbedding(
      meetingId,
      embedding.embedding.embedding,
    );
    this.updateMeetingEmbeddingMetadata(meetingId, embedding);
  }

  deleteMeetingIndex(meetingId: string): void {
    const tx = this.db.transaction(() => {
      this.deleteChunkVectors(meetingId);
      this.db.prepare('DELETE FROM chunks WHERE meeting_id = ?').run(meetingId);

      const summaryRows = this.db.prepare(`
        SELECT id
        FROM chunk_summaries
        WHERE meeting_id = ?
      `).all(meetingId) as Array<{ id: number }>;

      for (const summary of summaryRows) {
        this.deleteSummaryVectors(summary.id);
      }

      this.db.prepare('DELETE FROM chunk_summaries WHERE meeting_id = ?').run(meetingId);

      this.db.prepare('DELETE FROM embedding_queue WHERE meeting_id = ?').run(meetingId);

      this.db.prepare(`
        UPDATE meetings
        SET embedding_provider = NULL,
            embedding_dimensions = NULL,
            embedding_space = NULL
        WHERE id = ?
      `).run(meetingId);
    });

    tx();
  }

  deleteMeeting(meetingId: string): boolean {
    const tx = this.db.transaction(() => {
      this.deleteChunkVectors(meetingId);

      const summaryRows = this.db.prepare(`
        SELECT id
        FROM chunk_summaries
        WHERE meeting_id = ?
      `).all(meetingId) as Array<{ id: number }>;

      for (const summary of summaryRows) {
        this.deleteSummaryVectors(summary.id);
      }

      this.db.prepare('DELETE FROM embedding_queue WHERE meeting_id = ?').run(meetingId);
      this.db.prepare('DELETE FROM chunks WHERE meeting_id = ?').run(meetingId);
      this.db.prepare('DELETE FROM chunk_summaries WHERE meeting_id = ?').run(meetingId);
      this.db.prepare('DELETE FROM transcripts WHERE meeting_id = ?').run(meetingId);

      const result = this.db.prepare('DELETE FROM meetings WHERE id = ?').run(meetingId);
      return result.changes > 0;
    });

    return tx();
  }

  private toPhysicalChunkId(chunkId: string): number {
    if (!/^\d+$/.test(chunkId)) {
      throw new Error(`Meeting chunk ID is not a physical SQLite ID: ${chunkId}`);
    }

    const numericId = Number(chunkId);
    if (!Number.isSafeInteger(numericId)) {
      throw new Error(`Meeting chunk ID is outside the safe integer range: ${chunkId}`);
    }

    return numericId;
  }

  private updateMeetingEmbeddingMetadata(
    meetingId: string,
    embedding: MeetingStorageEmbedding,
  ): void {
    const { space, provider, dimensions } = embedding.embedding;

    this.db.prepare(`
      UPDATE meetings
      SET embedding_space = ?,
          embedding_provider = COALESCE(?, embedding_provider),
          embedding_dimensions = COALESCE(?, embedding_dimensions)
      WHERE id = ?
    `).run(
      space,
      provider ?? null,
      dimensions ?? null,
      meetingId,
    );
  }

  private deleteChunkVectors(meetingId: string): void {
    const rows = this.db.prepare(
      'SELECT id FROM chunks WHERE meeting_id = ?'
    ).all(meetingId) as Array<{ id: number }>;

    if (!rows.length) return;

    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(',');

    for (const dim of this.existingVecDims()) {
      try {
        this.db.prepare(
          `DELETE FROM vec_chunks_${dim} WHERE chunk_id IN (${placeholders})`
        ).run(...ids);
      } catch (error: any) {
        if (!/no such table/i.test(String(error?.message ?? error))) {
          throw error;
        }
      }
    }
  }

  private deleteSummaryVectors(summaryId: number): void {
    for (const dim of this.existingVecDims()) {
      try {
        this.db.prepare(
          `DELETE FROM vec_summaries_${dim} WHERE summary_id = ?`
        ).run(summaryId);
      } catch (error: any) {
        if (!/no such table/i.test(String(error?.message ?? error))) {
          throw error;
        }
      }
    }
  }

  private existingVecDims(): number[] {
    return DatabaseManager.getInstance().getExistingVecDims();
  }
}
