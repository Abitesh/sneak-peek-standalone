/**
 * Change 25 — Step 3.1
 * Mode legacy-to-canonical backfill.
 *
 * This service only reads legacy Mode storage. It materializes the canonical
 * document/revision/chunk representation and delegates canonical indexing to
 * CanonicalRagIndexer. Legacy Mode tables and indexes are never written.
 */

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { CanonicalEmbeddingService, type SourceIndependentEmbeddingProvider } from './CanonicalEmbeddingService';
import { CanonicalRagIndexer, type CanonicalIndexRunResult } from './CanonicalRagIndexer';
import { CanonicalRagStorage } from './CanonicalRagStorage';
import type { CanonicalChunkInput } from './CanonicalRagTypes';

const EXTRACTION_VERSION = 'mode-legacy-unknown-v1';
const CHUNKING_VERSION = 'mode-legacy-unknown-v1';
const NORMALIZATION_VERSION = 'mode-legacy-unknown-v1';
const LEGACY_EMBEDDING_VERSION = 'mode-legacy-space-v1';

interface LegacyModeFileRow {
  id: string;
  mode_id: string;
  file_name: string;
  content: string;
  created_at: string;
  page_count: number | null;
  extracted_page_count: number | null;
}

interface LegacyModeChunkRow {
  id: number;
  file_id: string;
  chunk_index: number;
  text: string;
  embedding: Buffer | null;
  embedding_space: string | null;
  created_at: number;
  page_start: number | null;
  page_end: number | null;
  section: string | null;
  heading: string | null;
  content_type: string;
  table_index: number | null;
  metadata_json: string;
}

export interface ModeBackfillResult {
  fileId: string;
  documentId: string;
  revisionId: string;
  chunkCount: number;
  embeddingSpaceId: string;
  complete: boolean;
  activated: boolean;
  legacyEmbeddingSpace: string | null;
  usedLegacyEmbeddings: boolean;
}

export interface ModeBackfillSummary {
  attempted: number;
  completed: number;
  failed: number;
  results: ModeBackfillResult[];
  errors: Array<{ fileId: string; error: string }>;
}

interface LegacyEmbeddingSet {
  space: string;
  dimensions: number;
  vectors: Map<number, number[]>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return { legacyMetadataParseError: true, legacyMetadataRaw: value };
  }
}

function bufferToVector(buffer: Buffer): number[] {
  if (buffer.byteLength === 0 || buffer.byteLength % 4 !== 0) {
    throw new Error('Legacy Mode embedding BLOB is not a Float32 vector');
  }
  const view = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  const vector = Array.from(view);
  if (vector.some((value) => !Number.isFinite(value))) {
    throw new Error('Legacy Mode embedding contains a non-finite value');
  }
  return vector;
}

function createLegacyProvider(set: LegacyEmbeddingSet, chunks: readonly LegacyModeChunkRow[]): SourceIndependentEmbeddingProvider {
  const byText = new Map<string, number[][]>();
  for (const chunk of chunks) {
    const vector = set.vectors.get(chunk.chunk_index);
    if (!vector) throw new Error(`Missing legacy Mode embedding for chunk index ${chunk.chunk_index}`);
    const list = byText.get(chunk.text) ?? [];
    list.push(vector);
    byText.set(chunk.text, list);
  }
  return {
    provider: 'legacy-mode',
    model: set.space,
    dimensions: set.dimensions,
    version: LEGACY_EMBEDDING_VERSION,
    async embedBatch(texts: readonly string[]) {
      const vectors: number[][] = [];
      for (const text of texts) {
        const list = byText.get(text);
        if (!list || list.length === 0) throw new Error('Missing legacy Mode embedding for canonical chunk text');
        vectors.push(list.shift()!);
      }
      return vectors;
    },
  };
}

/**
 * Backfills existing Mode reference files into canonical RAG storage.
 *
 * The database handle is read-only by convention for legacy tables: this class
 * contains SELECTs only against mode_reference_files/mode_reference_chunks.
 */
export class CanonicalModeBackfillService {
  constructor(
    private readonly db: Database.Database,
    private readonly storage: CanonicalRagStorage,
    private readonly indexerFactory: (embeddingService: CanonicalEmbeddingService) => CanonicalRagIndexer,
    private readonly fallbackProvider?: SourceIndependentEmbeddingProvider,
  ) {}

  listFileIds(modeId?: string): string[] {
    const rows = modeId
      ? this.db.prepare('SELECT id FROM mode_reference_files WHERE mode_id = ? ORDER BY created_at, id').all(modeId) as Array<{ id: string }>
      : this.db.prepare('SELECT id FROM mode_reference_files ORDER BY created_at, id').all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  async backfillAll(modeId?: string): Promise<ModeBackfillSummary> {
    const results: ModeBackfillResult[] = [];
    const errors: Array<{ fileId: string; error: string }> = [];
    for (const fileId of this.listFileIds(modeId)) {
      try {
        results.push(await this.backfillFile(fileId));
      } catch (error) {
        errors.push({ fileId, error: error instanceof Error ? error.message : String(error) });
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

  async backfillFile(fileId: string): Promise<ModeBackfillResult> {
    const file = this.readFile(fileId);
    if (!file) throw new Error(`Mode reference file not found: ${fileId}`);
    const chunks = this.readChunks(fileId);
    const contentHash = sha256(file.content);

    const document = this.storage.createDocument({
      sourceType: 'mode',
      sourceId: file.id,
      scopeId: file.mode_id,
      name: file.file_name,
      contentHash,
      metadata: {
        migration: 'change25-step3.1',
        legacyModeFileId: file.id,
        modeId: file.mode_id,
        pageCount: file.page_count,
        extractedPageCount: file.extracted_page_count,
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
        migration: 'change25-step3.1',
        legacyModeFileId: file.id,
        legacyVersionsUnknown: true,
      },
    });

    const canonicalChunks: CanonicalChunkInput[] = chunks.map((chunk) => ({
      chunkIndex: chunk.chunk_index,
      text: chunk.text,
      pageStart: chunk.page_start,
      pageEnd: chunk.page_end,
      section: chunk.section,
      heading: chunk.heading,
      contentType: chunk.content_type,
      tableIndex: chunk.table_index,
      sourceLocator: `legacy-mode:${file.id}:chunk:${chunk.chunk_index}`,
      metadata: {
        ...parseMetadata(chunk.metadata_json),
        legacyChunkId: chunk.id,
        legacyFileId: file.id,
      },
    }));

    const currentChunks = this.storage.readChunks(revision.id);
    if (currentChunks.length === 0) {
      this.storage.replaceChunks(document.id, revision.id, canonicalChunks);
    } else if (currentChunks.length !== canonicalChunks.length || currentChunks.some((chunk, index) => chunk.text !== canonicalChunks[index].text || chunk.chunkIndex !== canonicalChunks[index].chunkIndex)) {
      throw new Error(`Canonical revision already exists with different Mode chunks: ${revision.id}`);
    }

    const legacyEmbeddingSet = this.findCompleteLegacyEmbeddingSet(chunks);
    const provider = legacyEmbeddingSet
      ? createLegacyProvider(legacyEmbeddingSet, chunks)
      : this.fallbackProvider;
    if (!provider) {
      throw new Error(`Mode file ${fileId} has no complete legacy embedding space and no fallback canonical provider was supplied`);
    }

    const embeddingService = new CanonicalEmbeddingService(this.storage, provider);
    const indexer = this.indexerFactory(embeddingService);
    const indexResult = await this.indexerResult(indexer, revision.id, legacyEmbeddingSet?.space);

    return {
      fileId,
      documentId: indexResult.documentId,
      revisionId: indexResult.revisionId,
      chunkCount: indexResult.chunkCount,
      embeddingSpaceId: indexResult.embeddingSpaceId,
      complete: indexResult.complete,
      activated: indexResult.activated,
      legacyEmbeddingSpace: legacyEmbeddingSet?.space ?? null,
      usedLegacyEmbeddings: Boolean(legacyEmbeddingSet),
    };
  }

  private async indexerResult(indexer: CanonicalRagIndexer, revisionId: string, _legacySpace: string | undefined): Promise<CanonicalIndexRunResult> {
    return indexer.indexRevision(revisionId, { activate: true });
  }

  private findCompleteLegacyEmbeddingSet(chunks: LegacyModeChunkRow[]): LegacyEmbeddingSet | null {
    if (chunks.length === 0) return null;
    const groups = new Map<string, Map<number, number[]>>();
    for (const chunk of chunks) {
      if (!chunk.embedding || !chunk.embedding_space) continue;
      const vector = bufferToVector(chunk.embedding);
      const group = groups.get(chunk.embedding_space) ?? new Map<number, number[]>();
      group.set(chunk.chunk_index, vector);
      groups.set(chunk.embedding_space, group);
    }

    for (const [space, vectors] of groups) {
      if (vectors.size !== chunks.length) continue;
      const first = vectors.values().next().value as number[] | undefined;
      if (!first) continue;
      if (Array.from(vectors.values()).some((vector) => vector.length !== first.length)) {
        continue;
      }
      return { space, dimensions: first.length, vectors };
    }
    return null;
  }

  private readFile(fileId: string): LegacyModeFileRow | null {
    return this.db.prepare(`
      SELECT id, mode_id, file_name, content, created_at, page_count, extracted_page_count
      FROM mode_reference_files WHERE id = ?
    `).get(fileId) as LegacyModeFileRow | undefined ?? null;
  }

  private readChunks(fileId: string): LegacyModeChunkRow[] {
    return this.db.prepare(`
      SELECT id, file_id, chunk_index, text, embedding, embedding_space, created_at,
             page_start, page_end, section, heading, content_type, table_index, metadata_json
      FROM mode_reference_chunks
      WHERE file_id = ?
      ORDER BY chunk_index ASC
    `).all(fileId) as LegacyModeChunkRow[];
  }
}
