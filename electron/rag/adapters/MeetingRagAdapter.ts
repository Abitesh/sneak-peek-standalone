import type Database from 'better-sqlite3';
import type { RagSearchResult, RagDocument } from '../RAGManager';
import type { RAGRetriever } from '../RAGRetriever';
import type { RagSourceAdapter, RagSourceAdapterContext } from './RagSourceAdapter';

/** Thin adapter around the existing meeting RAGRetriever. */
export class MeetingRagAdapter implements RagSourceAdapter {
  constructor(
    private readonly retriever: RAGRetriever,
    private readonly db: Database.Database,
  ) {}

  async retrieve(context: RagSourceAdapterContext): Promise<RagSearchResult[]> {
    const { query, options, candidatePoolSize, tokenBudget, conversation } = context;
    const retrieved = await this.retriever.retrieve(query, {
      ...(options.meetingId ? { meetingId: options.meetingId } : {}),
      ...(conversation ? { conversation } : {}),
      topK: candidatePoolSize,
      candidatePoolSize,
      maxTokens: tokenBudget,
      deferFinalSelection: true,
      allowRerank: false,
    });

    const documentCache = new Map<string, RagDocument>();
    const results: RagSearchResult[] = [];
    for (const rawChunk of retrieved.chunks ?? []) {
      const c = rawChunk as any;
      const documentId = String(c.meetingId ?? options.meetingId ?? '');
      const text = String(c.text ?? '');
      if (!documentId || !text.trim()) continue;

      let document = documentCache.get(documentId);
      if (!document) {
        document = this.buildMeetingDocument(documentId);
        documentCache.set(documentId, document);
      }

      const chunkId = c.id ?? c.chunkId;
      const chunkIndex = Number(c.chunkIndex);
      const score = Number(c.finalScore ?? c.similarity);
      const semanticScore = Number(c.similarity);
      results.push({
        chunk: {
          id: String(chunkId ?? `${documentId}:${Number.isFinite(chunkIndex) ? chunkIndex : results.length}`),
          documentId,
          text,
          chunkIndex: Number.isFinite(chunkIndex) ? chunkIndex : 0,
          speaker: typeof c.speaker === 'string' ? c.speaker : undefined,
          timestampStart: Number.isFinite(Number(c.startMs)) ? Number(c.startMs) : undefined,
          timestampEnd: Number.isFinite(Number(c.endMs)) ? Number(c.endMs) : undefined,
          metadata: {
            tokenCount: c.tokenCount,
            meetingId: documentId,
          },
        },
        score: Number.isFinite(score) ? score : 0,
        semanticScore: Number.isFinite(semanticScore) ? semanticScore : undefined,
        source: document,
      });
    }
    return results;
  }

  private buildMeetingDocument(meetingId: string): RagDocument {
    let row: any = null;
    try {
      row = this.db.prepare(`
        SELECT id, title, start_time, duration_ms, source, created_at, summary_json
        FROM meetings
        WHERE id = ?
        LIMIT 1
      `).get(meetingId);
    } catch (error) {
      console.warn('[MeetingRagAdapter] Failed to load meeting metadata:', error);
    }
    return {
      id: meetingId,
      sourceType: 'meeting',
      name: String(row?.title ?? meetingId),
      metadata: {
        meetingId,
        ...(row?.start_time !== undefined ? { startTime: row.start_time } : {}),
        ...(row?.duration_ms !== undefined ? { durationMs: row.duration_ms } : {}),
        ...(row?.source !== undefined ? { source: row.source } : {}),
        ...(row?.created_at !== undefined ? { createdAt: row.created_at } : {}),
        ...(row?.summary_json !== undefined ? { summaryJson: row.summary_json } : {}),
      },
    };
  }
}
