import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type {
  CanonicalChunkInput,
  CanonicalRagChunk,
  CanonicalRagDocument,
  CanonicalRagEmbedding,
  CanonicalRagEmbeddingSpace,
  CanonicalRagExtractionState,
  CanonicalRagIndexJob,
  CanonicalRagIndexStatus,
  CanonicalRagIndexStatusRecord,
  CanonicalRagJobState,
  CanonicalRagJobType,
  CanonicalRagRevision,
  CreateDocumentInput,
  CreateRevisionInput,
  EmbeddingSpaceInput,
  IndexJobInput,
  ClaimJobOptions,
  VectorConsistencyReport,
} from './CanonicalRagTypes';

const MAX_VECTOR_DIMENSIONS = 100_000;
const SUPPORTED_METRIC = 'cosine';
const ACTIVE_STATUS = 'READY';

const STATUS_TRANSITIONS: Record<CanonicalRagIndexStatus, readonly CanonicalRagIndexStatus[]> = {
  NOT_INDEXED: ['QUEUED'],
  QUEUED: ['EXTRACTING', 'FAILED'],
  EXTRACTING: ['OCR_REQUIRED', 'CHUNKING', 'FAILED'],
  OCR_REQUIRED: ['EXTRACTING', 'FAILED'],
  CHUNKING: ['LEXICAL_READY', 'FAILED'],
  LEXICAL_READY: ['EMBEDDING', 'READY', 'FAILED'],
  EMBEDDING: ['READY', 'FAILED'],
  READY: ['EMBEDDING', 'QUEUED', 'FAILED'],
  FAILED: ['QUEUED'],
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/**
 * Length-prefixed canonical serialization prevents ambiguity from simple
 * concatenation. Example: ["ab", "c"] and ["a", "bc"] serialize differently.
 */
function serializeIdentity(parts: readonly string[]): string {
  return parts.map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('|');
}

function sha256(parts: readonly string[]): string {
  return createHash('sha256').update(serializeIdentity(parts), 'utf8').digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

function nowMs(): number {
  return Date.now();
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_VECTOR_DIMENSIONS) {
    throw new Error(`${label} must be an integer in 1..${MAX_VECTOR_DIMENSIONS}`);
  }
}

function validateVector(vector: readonly number[], expectedDimensions: number): Float32Array {
  if (!Array.isArray(vector) && !(vector instanceof Float32Array)) {
    throw new Error('Embedding vector must be an array or Float32Array');
  }
  if (vector.length === 0) throw new Error('Embedding vector cannot be empty');
  if (vector.length !== expectedDimensions) {
    throw new Error(`Embedding dimension mismatch: expected ${expectedDimensions}, got ${vector.length}`);
  }

  const out = new Float32Array(expectedDimensions);
  for (let i = 0; i < vector.length; i += 1) {
    const value = Number(vector[i]);
    if (!Number.isFinite(value)) throw new Error(`Embedding vector contains non-finite value at index ${i}`);
    if (Math.fround(value) !== value && Math.abs(value) > 3.4028235e38) {
      throw new Error(`Embedding vector value at index ${i} is outside Float32 range`);
    }
    out[i] = Math.fround(value);
    if (!Number.isFinite(out[i])) throw new Error(`Embedding vector cannot be represented as Float32 at index ${i}`);
  }
  return out;
}

export class CanonicalRagStorage {
  constructor(private readonly db: Database.Database) {}

  createDocument(input: CreateDocumentInput): CanonicalRagDocument {
    const existing = this.readDocumentBySource(input.sourceType, input.sourceId);
    if (existing) return existing;

    const id = input.id ?? randomUUID();
    const timestamp = nowIso();
    const metadataJson = canonicalJson(input.metadata ?? {});
    this.db.prepare(`
      INSERT INTO rag_documents (
        id, source_type, source_id, owner_id, scope_id, name, path,
        mime_type, file_type, size_bytes, content_hash, created_at,
        updated_at, current_revision_id, deleted_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
    `).run(
      id,
      input.sourceType,
      input.sourceId,
      input.ownerId ?? null,
      input.scopeId ?? null,
      input.name,
      input.path ?? null,
      input.mimeType ?? null,
      input.fileType ?? null,
      input.sizeBytes ?? null,
      input.contentHash ?? null,
      timestamp,
      timestamp,
      metadataJson,
    );
    return this.readDocument(id)!;
  }

  readDocument(documentId: string): CanonicalRagDocument | null {
    const row = this.db.prepare('SELECT * FROM rag_documents WHERE id = ?').get(documentId) as any;
    return row ? this.mapDocument(row) : null;
  }

  readDocumentBySource(sourceType: string, sourceId: string): CanonicalRagDocument | null {
    const row = this.db.prepare(`
      SELECT * FROM rag_documents WHERE source_type = ? AND source_id = ? LIMIT 1
    `).get(sourceType, sourceId) as any;
    return row ? this.mapDocument(row) : null;
  }

  updateDocument(documentId: string, updates: Partial<Pick<CanonicalRagDocument, 'name' | 'path' | 'mimeType' | 'fileType' | 'sizeBytes' | 'contentHash' | 'metadata'>>): CanonicalRagDocument {
    const current = this.readDocument(documentId);
    if (!current) throw new Error(`Canonical document not found: ${documentId}`);
    const next = {
      name: updates.name ?? current.name,
      path: updates.path === undefined ? current.path : updates.path,
      mimeType: updates.mimeType === undefined ? current.mimeType : updates.mimeType,
      fileType: updates.fileType === undefined ? current.fileType : updates.fileType,
      sizeBytes: updates.sizeBytes === undefined ? current.sizeBytes : updates.sizeBytes,
      contentHash: updates.contentHash === undefined ? current.contentHash : updates.contentHash,
      metadataJson: canonicalJson(updates.metadata ?? current.metadata),
    };
    this.db.prepare(`
      UPDATE rag_documents
      SET name = ?, path = ?, mime_type = ?, file_type = ?, size_bytes = ?,
          content_hash = ?, metadata_json = ?, updated_at = ?
      WHERE id = ?
    `).run(next.name, next.path, next.mimeType, next.fileType, next.sizeBytes,
      next.contentHash, next.metadataJson, nowIso(), documentId);
    return this.readDocument(documentId)!;
  }

  createRevision(input: CreateRevisionInput): CanonicalRagRevision {
    const document = this.requireDocument(input.documentId);
    if (document.deletedAt) throw new Error('Cannot create a revision for a deleted document');

    const id = this.revisionId(
      input.documentId,
      input.contentHash,
      input.extractionVersion,
      input.chunkingVersion,
      input.normalizationVersion,
    );
    const existing = this.readRevision(id);
    if (existing) return existing;

    const representation = this.db.prepare(`
      SELECT * FROM rag_document_revisions
      WHERE document_id = ? AND content_hash = ? AND extraction_version = ?
        AND chunking_version = ? AND normalization_version = ?
      LIMIT 1
    `).get(input.documentId, input.contentHash, input.extractionVersion,
      input.chunkingVersion, input.normalizationVersion) as any;
    if (representation) return this.mapRevision(representation);

    const max = this.db.prepare(`
      SELECT COALESCE(MAX(revision_number), 0) AS n
      FROM rag_document_revisions WHERE document_id = ?
    `).get(input.documentId) as { n: number };
    const revisionNumber = Number(max.n) + 1;
    const createdAt = input.createdAt ?? nowIso();

    this.db.prepare(`
      INSERT INTO rag_document_revisions (
        id, document_id, revision_number, content_hash, extraction_version,
        chunking_version, normalization_version, extraction_state,
        created_at, superseded_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      id,
      input.documentId,
      revisionNumber,
      input.contentHash,
      input.extractionVersion,
      input.chunkingVersion,
      input.normalizationVersion,
      input.extractionState ?? 'PENDING',
      createdAt,
      canonicalJson(input.metadata ?? {}),
    );
    void document;
    return this.readRevision(id)!;
  }

  readRevision(revisionId: string): CanonicalRagRevision | null {
    const row = this.db.prepare('SELECT * FROM rag_document_revisions WHERE id = ?').get(revisionId) as any;
    return row ? this.mapRevision(row) : null;
  }

  readRevisions(documentId: string): CanonicalRagRevision[] {
    const rows = this.db.prepare(`
      SELECT * FROM rag_document_revisions WHERE document_id = ? ORDER BY revision_number ASC
    `).all(documentId) as any[];
    return rows.map((row) => this.mapRevision(row));
  }

  replaceChunks(documentId: string, revisionId: string, chunks: readonly CanonicalChunkInput[]): CanonicalRagChunk[] {
    const revision = this.requireRevision(revisionId);
    if (revision.documentId !== documentId) throw new Error('Chunk document/revision mismatch');
    const document = this.requireDocument(documentId);
    if (document.deletedAt) throw new Error('Cannot write chunks for a deleted document');
    const existingStatus = this.getStatus(documentId, revisionId);
    if (existingStatus && ['READY', 'EMBEDDING'].includes(existingStatus.status)) {
      throw new Error('Cannot replace chunks after indexing has become active; create a new revision');
    }

    const tx = this.db.transaction(() => {
      this.deleteFtsForRevision(revisionId);
      this.db.prepare('DELETE FROM rag_chunks WHERE revision_id = ?').run(revisionId);
      const insert = this.db.prepare(`
        INSERT INTO rag_chunks (
          id, document_id, revision_id, chunk_index, text, content_hash,
          page_start, page_end, section, heading, content_type, start_char,
          end_char, table_index, token_count, speaker, timestamp_start,
          timestamp_end, source_locator, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const chunk of chunks) {
        if (!Number.isInteger(chunk.chunkIndex) || chunk.chunkIndex < 0) {
          throw new Error(`Invalid chunk index: ${chunk.chunkIndex}`);
        }
        const contentHash = createHash('sha256').update(chunk.text, 'utf8').digest('hex');
        const locator = chunk.sourceLocator ?? `${chunk.chunkIndex}`;
        const id = this.chunkId(documentId, revisionId, locator, contentHash);
        insert.run(
          id, documentId, revisionId, chunk.chunkIndex, chunk.text, contentHash,
          chunk.pageStart ?? null, chunk.pageEnd ?? null, chunk.section ?? null,
          chunk.heading ?? null, chunk.contentType ?? null, chunk.startChar ?? null,
          chunk.endChar ?? null, chunk.tableIndex ?? null, chunk.tokenCount ?? null,
          chunk.speaker ?? null, chunk.timestampStart ?? null, chunk.timestampEnd ?? null,
          locator, canonicalJson(chunk.metadata ?? {}), nowIso(),
        );
      }
      this.rebuildFtsForRevision(revisionId);
      this.ensureStatusRow(documentId, revisionId, 'NOT_INDEXED');
      const currentStatus = this.getStatus(documentId, revisionId)!;
      if (currentStatus.status === 'NOT_INDEXED') this.transitionStatus(documentId, revisionId, 'QUEUED');
      const queuedStatus = this.getStatus(documentId, revisionId)!;
      if (queuedStatus.status === 'QUEUED') this.transitionStatus(documentId, revisionId, 'EXTRACTING');
      const extractingStatus = this.getStatus(documentId, revisionId)!;
      if (extractingStatus.status === 'EXTRACTING') this.transitionStatus(documentId, revisionId, 'CHUNKING');
      this.transitionStatus(documentId, revisionId, 'LEXICAL_READY');
    });
    tx();
    return this.readChunks(revisionId);
  }

  readChunks(revisionId: string): CanonicalRagChunk[] {
    const rows = this.db.prepare(`
      SELECT * FROM rag_chunks WHERE revision_id = ? ORDER BY chunk_index ASC
    `).all(revisionId) as any[];
    return rows.map((row) => this.mapChunk(row));
  }

  createEmbeddingSpace(input: EmbeddingSpaceInput): CanonicalRagEmbeddingSpace {
    assertPositiveInteger(input.dimensions, 'Embedding dimensions');
    if ((input.metric ?? SUPPORTED_METRIC) !== SUPPORTED_METRIC) {
      throw new Error(`Unsupported embedding metric: ${input.metric}`);
    }

    const existing = this.db.prepare(`
      SELECT * FROM rag_embedding_spaces
      WHERE provider = ? AND model = ? AND dimensions = ? AND metric = ? AND version = ?
      LIMIT 1
    `).get(input.provider, input.model, input.dimensions, input.metric ?? SUPPORTED_METRIC, input.version) as any;
    if (existing) return this.mapSpace(existing);

    const id = input.id ?? randomUUID();
    const keyRow = this.db.prepare(`
      SELECT COALESCE(MAX(vector_table_key), 0) + 1 AS next_key
      FROM rag_embedding_spaces
    `).get() as { next_key: number };
    const vectorTableKey = Number(keyRow.next_key);
    this.db.prepare(`
      INSERT INTO rag_embedding_spaces (
        id, provider, model, dimensions, metric, version, created_at,
        retired_at, vector_table_key, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(id, input.provider, input.model, input.dimensions, input.metric ?? SUPPORTED_METRIC,
      input.version, nowIso(), vectorTableKey, canonicalJson(input.metadata ?? {}));
    return this.readEmbeddingSpace(id)!;
  }

  readEmbeddingSpace(spaceId: string): CanonicalRagEmbeddingSpace | null {
    const row = this.db.prepare('SELECT * FROM rag_embedding_spaces WHERE id = ?').get(spaceId) as any;
    return row ? this.mapSpace(row) : null;
  }

  listEmbeddingSpaces(): CanonicalRagEmbeddingSpace[] {
    const rows = this.db.prepare('SELECT * FROM rag_embedding_spaces ORDER BY vector_table_key').all() as any[];
    return rows.map((row) => this.mapSpace(row));
  }

  storeEmbedding(chunkId: string, spaceId: string, vector: readonly number[], metadata: Record<string, unknown> = {}): CanonicalRagEmbedding {
    const chunk = this.db.prepare('SELECT id FROM rag_chunks WHERE id = ?').get(chunkId) as { id: string } | undefined;
    if (!chunk) throw new Error(`Canonical chunk not found: ${chunkId}`);
    const space = this.requireSpace(spaceId);
    const floatVector = validateVector(vector, space.dimensions);
    this.ensureCanonicalVectorTable(space);

    const embeddingId = sha256(['canonical-embedding', chunkId, spaceId]);
    const vectorBuffer = Buffer.from(floatVector.buffer, floatVector.byteOffset, floatVector.byteLength);

    const tx = this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT physical_row_key FROM rag_embeddings
        WHERE chunk_id = ? AND embedding_space_id = ?
      `).get(chunkId, spaceId) as { physical_row_key: number } | undefined;

      let physicalRowKey: number;
      if (existing) {
        physicalRowKey = Number(existing.physical_row_key);
        this.db.prepare(`
          UPDATE rag_embeddings
          SET id = ?, vector = ?, created_at = ?, metadata_json = ?
          WHERE physical_row_key = ?
        `).run(embeddingId, vectorBuffer, nowIso(), canonicalJson(metadata), physicalRowKey);
        this.deleteVectorRow(space, physicalRowKey);
      } else {
        const inserted = this.db.prepare(`
          INSERT INTO rag_embeddings (
            id, chunk_id, embedding_space_id, physical_row_key, vector, created_at, metadata_json
          ) VALUES (?, ?, ?, (SELECT COALESCE(MAX(physical_row_key), 0) + 1 FROM rag_embeddings), ?, ?, ?)
          RETURNING physical_row_key
        `).get(embeddingId, chunkId, spaceId, vectorBuffer, nowIso(), canonicalJson(metadata)) as { physical_row_key: number };
        physicalRowKey = Number(inserted.physical_row_key);
      }
      this.insertVectorRow(space, physicalRowKey, floatVector);
    });

    try {
      tx();
    } catch (error) {
      // The canonical/vector operation is deliberately transaction-bounded.
      // If a sqlite-vec runtime does not participate in SQLite transactions,
      // this catch becomes the repair boundary for the future worker.
      throw new Error(`Canonical embedding/vector write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return this.readEmbedding(embeddingId)!;
  }

  readEmbedding(embeddingId: string): CanonicalRagEmbedding | null {
    const row = this.db.prepare('SELECT * FROM rag_embeddings WHERE id = ?').get(embeddingId) as any;
    return row ? this.mapEmbedding(row) : null;
  }

  deleteEmbedding(chunkId: string, spaceId: string): void {
    const space = this.requireSpace(spaceId);
    const tx = this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT physical_row_key FROM rag_embeddings
        WHERE chunk_id = ? AND embedding_space_id = ?
      `).all(chunkId, spaceId) as Array<{ physical_row_key: number }>;
      if (this.vectorTableExists(space)) {
        for (const row of rows) this.deleteVectorRow(space, Number(row.physical_row_key));
      }
      this.db.prepare(`
        DELETE FROM rag_embeddings WHERE chunk_id = ? AND embedding_space_id = ?
      `).run(chunkId, spaceId);
    });
    tx();
  }

  rebuildVectorIndex(spaceId: string): { inserted: number; removed: number } {
    const space = this.requireSpace(spaceId);
    this.ensureCanonicalVectorTable(space);
    const expected = this.db.prepare(`
      SELECT physical_row_key, vector FROM rag_embeddings WHERE embedding_space_id = ?
      ORDER BY physical_row_key
    `).all(spaceId) as Array<{ physical_row_key: number; vector: Buffer }>;

    // Conservative rebuild: clear and repopulate the derived table. We do not
    // claim an atomic virtual-table swap because sqlite-vec swap semantics are
    // not verified in this repository/runtime.
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM ${this.vectorTableName(space.vectorTableKey)}`).run();
      const insert = this.db.prepare(`
        INSERT INTO ${this.vectorTableName(space.vectorTableKey)} (rowid, embedding)
        VALUES (?, ?)
      `);
      for (const row of expected) insert.run(BigInt(row.physical_row_key), row.vector);
    });
    tx();
    return { inserted: expected.length, removed: 0 };
  }

  checkVectorIndex(spaceId: string): VectorConsistencyReport {
    const space = this.requireSpace(spaceId);
    this.ensureCanonicalVectorTable(space);
    const canonicalRows = this.db.prepare(`
      SELECT physical_row_key, vector FROM rag_embeddings WHERE embedding_space_id = ?
    `).all(spaceId) as Array<{ physical_row_key: number; vector: Buffer }>;
    const vectorRows = this.db.prepare(`
      SELECT rowid AS physical_row_key, embedding FROM ${this.vectorTableName(space.vectorTableKey)}
    `).all() as Array<{ physical_row_key: number; embedding: Buffer }>;
    const canonical = new Map(canonicalRows.map((row) => [Number(row.physical_row_key), row]));
    let missing = 0;
    let dimensionMismatch = 0;
    for (const row of canonicalRows) {
      const vector = vectorRows.find((candidate) => Number(candidate.physical_row_key) === Number(row.physical_row_key));
      if (!vector) {
        missing += 1;
        continue;
      }
      if (vector.embedding.byteLength !== space.dimensions * 4) dimensionMismatch += 1;
    }
    let orphan = 0;
    for (const row of vectorRows) if (!canonical.has(Number(row.physical_row_key))) orphan += 1;
    return {
      spaceId,
      vectorTableKey: space.vectorTableKey,
      canonicalEmbeddings: canonicalRows.length,
      vectorRows: vectorRows.length,
      missingVectorRows: missing,
      orphanVectorRows: orphan,
      dimensionMismatchRows: dimensionMismatch,
    };
  }

  checkVectorIndexForRevision(spaceId: string, revisionId: string): VectorConsistencyReport {
    const space = this.requireSpace(spaceId);
    this.ensureCanonicalVectorTable(space);
    const canonicalRows = this.db.prepare(`
      SELECT e.physical_row_key, e.vector
      FROM rag_embeddings e JOIN rag_chunks c ON c.id = e.chunk_id
      WHERE c.revision_id = ? AND e.embedding_space_id = ?
    `).all(revisionId, spaceId) as Array<{ physical_row_key: number; vector: Buffer }>;
    let missing = 0;
    let dimensionMismatch = 0;
    for (const row of canonicalRows) {
      const vector = this.db.prepare(`SELECT embedding FROM ${this.vectorTableName(space.vectorTableKey)} WHERE rowid = ? LIMIT 1`).get(row.physical_row_key) as { embedding: Buffer } | undefined;
      if (!vector) { missing += 1; continue; }
      if (vector.embedding.byteLength !== space.dimensions * 4) dimensionMismatch += 1;
    }
    return {
      spaceId,
      vectorTableKey: space.vectorTableKey,
      canonicalEmbeddings: canonicalRows.length,
      vectorRows: canonicalRows.length - missing,
      missingVectorRows: missing,
      orphanVectorRows: 0,
      dimensionMismatchRows: dimensionMismatch,
    };
  }

  rebuildFts(revisionId?: string): number {
    if (revisionId) {
      this.deleteFtsForRevision(revisionId);
      return this.rebuildFtsForRevision(revisionId);
    }
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM rag_chunks_fts').run();
      const rows = this.db.prepare(`
        SELECT c.id, c.document_id, c.revision_id, d.source_type, d.name,
               c.heading, c.section, c.text
        FROM rag_chunks c
        JOIN rag_documents d ON d.id = c.document_id
      `).all() as any[];
      const insert = this.db.prepare(`
        INSERT INTO rag_chunks_fts
          (chunk_id, document_id, revision_id, source_type, document_name, heading, section, text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of rows) insert.run(row.id, row.document_id, row.revision_id, row.source_type,
        row.name, row.heading ?? '', row.section ?? '', row.text);
      return rows.length;
    });
    return tx() as number;
  }

  checkFts(revisionId?: string): { expected: number; actual: number; missing: number } {
    const expected = revisionId
      ? Number((this.db.prepare('SELECT COUNT(*) AS n FROM rag_chunks WHERE revision_id = ?').get(revisionId) as any).n)
      : Number((this.db.prepare('SELECT COUNT(*) AS n FROM rag_chunks').get() as any).n);
    const actual = revisionId
      ? Number((this.db.prepare('SELECT COUNT(*) AS n FROM rag_chunks_fts WHERE revision_id = ?').get(revisionId) as any).n)
      : Number((this.db.prepare('SELECT COUNT(*) AS n FROM rag_chunks_fts').get() as any).n);
    return { expected, actual, missing: Math.max(0, expected - actual) };
  }

  getStatus(documentId: string, revisionId: string): CanonicalRagIndexStatusRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM rag_canonical_index_status WHERE document_id = ? AND revision_id = ?
    `).get(documentId, revisionId) as any;
    return row ? this.mapStatus(row) : null;
  }

  setStatus(documentId: string, revisionId: string, next: CanonicalRagIndexStatus, details?: Partial<Pick<CanonicalRagIndexStatusRecord, 'chunkCount' | 'embeddedChunkCount' | 'extractedPageCount' | 'totalPageCount' | 'errorCode' | 'errorMessage'>>): CanonicalRagIndexStatusRecord {
    const current = this.getStatus(documentId, revisionId);
    if (!current) {
      if (next !== 'NOT_INDEXED' && next !== 'QUEUED') throw new Error(`Invalid initial status: ${next}`);
      this.ensureStatusRow(documentId, revisionId, next);
      return this.getStatus(documentId, revisionId)!;
    }
    if (current.status === next) return this.updateStatusDetails(documentId, revisionId, details);
    const allowed = STATUS_TRANSITIONS[current.status];
    if (!allowed.includes(next)) {
      throw new Error(`Invalid canonical RAG status transition: ${current.status} -> ${next}`);
    }
    this.db.prepare(`
      UPDATE rag_canonical_index_status
      SET status = ?, chunk_count = COALESCE(?, chunk_count),
          embedded_chunk_count = COALESCE(?, embedded_chunk_count),
          extracted_page_count = COALESCE(?, extracted_page_count),
          total_page_count = COALESCE(?, total_page_count),
          error_code = ?, error_message = ?, updated_at = ?
      WHERE document_id = ? AND revision_id = ?
    `).run(next, details?.chunkCount ?? null, details?.embeddedChunkCount ?? null,
      details?.extractedPageCount ?? null, details?.totalPageCount ?? null,
      details?.errorCode ?? (next === 'FAILED' ? current.errorCode : null),
      details?.errorMessage ?? (next === 'FAILED' ? current.errorMessage : null),
      nowMs(), documentId, revisionId);
    return this.getStatus(documentId, revisionId)!;
  }

  enqueueJob(input: IndexJobInput): CanonicalRagIndexJob {
    this.requireRevisionForDocument(input.documentId, input.revisionId);
    if (input.jobType === 'embed' && !input.embeddingSpaceId) {
      throw new Error('Embedding jobs require embeddingSpaceId');
    }
    if (input.jobType !== 'embed' && input.embeddingSpaceId) {
      throw new Error('Only embed jobs may have embeddingSpaceId');
    }
    if (input.embeddingSpaceId) this.requireSpace(input.embeddingSpaceId);

    const existing = this.db.prepare(`
      SELECT * FROM rag_index_jobs
      WHERE document_id = ? AND revision_id = ? AND job_type = ?
        AND ((embedding_space_id IS NULL AND ? IS NULL) OR embedding_space_id = ?)
      LIMIT 1
    `).get(input.documentId, input.revisionId, input.jobType,
      input.embeddingSpaceId ?? null, input.embeddingSpaceId ?? null) as any;
    if (existing) return this.mapJob(existing);

    const now = nowMs();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO rag_index_jobs (
        id, document_id, revision_id, job_type, embedding_space_id, state,
        attempt_count, max_attempts, available_at, lease_until, leased_by,
        last_error, created_at, updated_at, completed_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, 'QUEUED', 0, ?, ?, NULL, NULL, NULL, ?, ?, NULL, ?)
    `).run(id, input.documentId, input.revisionId, input.jobType,
      input.embeddingSpaceId ?? null, input.maxAttempts ?? 3,
      input.availableAt ?? now, now, now, canonicalJson(input.metadata ?? {}));
    return this.readJob(id)!;
  }

  /**
   * Atomically claim one specific job. This prevents a worker from claiming a
   * different job when several canonical indexing workers run concurrently.
   */
  claimSpecificJob(jobId: string, options: ClaimJobOptions): CanonicalRagIndexJob | null {
    const now = options.now ?? nowMs();
    const leaseMs = options.leaseMs ?? 60_000;
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT j.*
        FROM rag_index_jobs j
        JOIN rag_documents d ON d.id = j.document_id
        WHERE j.id = ?
          AND j.state IN ('QUEUED', 'RETRY_WAIT', 'RUNNING')
          AND j.available_at <= ?
          AND (j.lease_until IS NULL OR j.lease_until <= ?)
          AND d.deleted_at IS NULL
          AND (d.current_revision_id IS NULL OR d.current_revision_id = j.revision_id)
      `).get(jobId, now, now) as any;
      if (!row) return null;
      const attempt = Number(row.attempt_count) + 1;
      this.db.prepare(`
        UPDATE rag_index_jobs
        SET state = 'RUNNING', attempt_count = ?, lease_until = ?, leased_by = ?, updated_at = ?
        WHERE id = ?
      `).run(attempt, now + leaseMs, options.workerId, now, jobId);
      return this.readJob(jobId);
    });
    return tx() as CanonicalRagIndexJob | null;
  }

  claimJob(options: ClaimJobOptions): CanonicalRagIndexJob | null {
    const now = options.now ?? nowMs();
    const leaseMs = options.leaseMs ?? 60_000;
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT j.*
        FROM rag_index_jobs j
        JOIN rag_documents d ON d.id = j.document_id
        WHERE j.state IN ('QUEUED', 'RETRY_WAIT', 'RUNNING')
          AND j.available_at <= ?
          AND (j.lease_until IS NULL OR j.lease_until <= ?)
          AND d.deleted_at IS NULL
          AND (d.current_revision_id IS NULL OR d.current_revision_id = j.revision_id)
        ORDER BY j.created_at ASC
        LIMIT 1
      `).get(now, now) as any;
      if (!row) return null;
      const attempt = Number(row.attempt_count) + 1;
      this.db.prepare(`
        UPDATE rag_index_jobs
        SET state = 'RUNNING', attempt_count = ?, lease_until = ?, leased_by = ?, updated_at = ?
        WHERE id = ?
      `).run(attempt, now + leaseMs, options.workerId, now, row.id);
      return this.readJob(String(row.id));
    });
    return tx() as CanonicalRagIndexJob | null;
  }

  cancelObsoleteJobs(documentId: string, currentRevisionId: string, reason = 'obsolete revision'): number {
    const result = this.db.prepare(`
      UPDATE rag_index_jobs
      SET state = 'CANCELLED', lease_until = NULL, leased_by = NULL,
          last_error = ?, updated_at = ?
      WHERE document_id = ? AND revision_id != ?
        AND state IN ('QUEUED', 'RUNNING', 'RETRY_WAIT')
    `).run(reason, nowMs(), documentId, currentRevisionId);
    return Number(result.changes);
  }

  completeJob(jobId: string, workerId?: string): CanonicalRagIndexJob {
    const job = this.requireJob(jobId);
    if (job.state !== 'RUNNING') throw new Error(`Cannot complete job in state ${job.state}`);
    if (workerId && job.leasedBy !== workerId) {
      throw new Error(`Canonical indexing job ${jobId} is leased by another worker`);
    }
    this.db.prepare(`
      UPDATE rag_index_jobs
      SET state = 'COMPLETED', lease_until = NULL, leased_by = NULL,
          completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(nowMs(), nowMs(), jobId);
    return this.readJob(jobId)!;
  }

  failJob(jobId: string, errorMessage: string, retry = true, workerId?: string): CanonicalRagIndexJob {
    const job = this.requireJob(jobId);
    if (job.state !== 'RUNNING') throw new Error(`Cannot fail job in state ${job.state}`);
    if (workerId && job.leasedBy !== workerId) {
      throw new Error(`Canonical indexing job ${jobId} is leased by another worker`);
    }
    const exhausted = job.attemptCount >= job.maxAttempts;
    const state: CanonicalRagJobState = retry && !exhausted ? 'RETRY_WAIT' : 'FAILED';
    this.db.prepare(`
      UPDATE rag_index_jobs
      SET state = ?, available_at = ?, lease_until = NULL, leased_by = NULL,
          last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(state, nowMs() + (state === 'RETRY_WAIT' ? 1_000 : 0), errorMessage, nowMs(), jobId);
    return this.readJob(jobId)!;
  }

  cancelJob(jobId: string, reason = 'cancelled'): CanonicalRagIndexJob {
    this.requireJob(jobId);
    this.db.prepare(`
      UPDATE rag_index_jobs
      SET state = 'CANCELLED', lease_until = NULL, leased_by = NULL,
          last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(reason, nowMs(), jobId);
    return this.readJob(jobId)!;
  }

  activateRevision(documentId: string, revisionId: string, requiredEmbeddingSpaceIds: readonly string[] = [], allowRollback = false): CanonicalRagDocument {
    const tx = this.db.transaction(() => {
      const document = this.requireDocument(documentId);
      if (document.deletedAt) throw new Error('Deleted document cannot activate a revision');
      const revision = this.requireRevisionForDocument(documentId, revisionId);
      if (document.currentRevisionId && document.currentRevisionId !== revisionId) {
        const currentRevision = this.requireRevision(document.currentRevisionId);
        if (!allowRollback && revision.revisionNumber < currentRevision.revisionNumber) {
          throw new Error('Stale revision cannot overwrite a newer current revision; use rollbackRevision explicitly');
        }
      }
      const status = this.getStatus(documentId, revisionId);
      if (!status || status.status !== ACTIVE_STATUS) throw new Error('Revision is not READY');

      const chunks = Number((this.db.prepare('SELECT COUNT(*) AS n FROM rag_chunks WHERE revision_id = ?').get(revisionId) as any).n);
      if (chunks <= 0 || chunks !== status.chunkCount) throw new Error('Revision chunk readiness is incomplete');
      const fts = this.checkFts(revisionId);
      if (fts.actual !== fts.expected) throw new Error('Revision FTS readiness is incomplete');

      for (const spaceId of requiredEmbeddingSpaceIds) {
        const space = this.requireSpace(spaceId);
        const embedded = Number((this.db.prepare(`
          SELECT COUNT(*) AS n
          FROM rag_embeddings e JOIN rag_chunks c ON c.id = e.chunk_id
          WHERE c.revision_id = ? AND e.embedding_space_id = ?
        `).get(revisionId, spaceId) as any).n);
        if (embedded !== chunks) throw new Error(`Embedding readiness is incomplete for space ${spaceId}`);
        const report = this.checkVectorIndexForRevision(space.id, revisionId);
        if (report.missingVectorRows > 0 || report.dimensionMismatchRows > 0) {
          throw new Error(`Vector readiness is incomplete for space ${spaceId}`);
        }
      }

      if (document.currentRevisionId === revisionId) return document;
      const timestamp = nowIso();
      this.db.prepare(`
        UPDATE rag_document_revisions
        SET superseded_at = ?
        WHERE document_id = ? AND id != ? AND superseded_at IS NULL
      `).run(timestamp, documentId, revisionId);
      this.db.prepare(`
        UPDATE rag_document_revisions SET superseded_at = NULL
        WHERE id = ? AND document_id = ?
      `).run(revisionId, documentId);
      this.db.prepare(`
        UPDATE rag_documents SET current_revision_id = ?, updated_at = ? WHERE id = ?
      `).run(revisionId, timestamp, documentId);
      return this.readDocument(documentId)!;
    });
    return tx() as CanonicalRagDocument;
  }

  rollbackRevision(documentId: string, revisionId: string, requiredEmbeddingSpaceIds: readonly string[] = []): CanonicalRagDocument {
    return this.activateRevision(documentId, revisionId, requiredEmbeddingSpaceIds, true);
  }

  softDeleteDocument(documentId: string): void {
    const tx = this.db.transaction(() => {
      const document = this.requireDocument(documentId);
      const jobs = this.db.prepare('SELECT id FROM rag_index_jobs WHERE document_id = ?').all(documentId) as Array<{ id: string }>;
      for (const job of jobs) this.cancelJob(String(job.id), 'document deleted');
      for (const space of this.listEmbeddingSpaces()) {
        this.deleteExistingVectorRowsForDocument(space, documentId);
      }
      // Canonical embeddings are authoritative for the indexed document state.
      // Soft deletion invalidates that indexed state, so remove them after the
      // physical vector rows have been cleaned up. The document/revisions/chunks
      // remain available as the retained source history.
      this.db.prepare(`
        DELETE FROM rag_embeddings
        WHERE chunk_id IN (
          SELECT id FROM rag_chunks WHERE document_id = ?
        )
      `).run(documentId);
      const revisions = this.db.prepare('SELECT id FROM rag_document_revisions WHERE document_id = ?').all(documentId) as Array<{ id: string }>;
      for (const revision of revisions) this.deleteFtsForRevision(String(revision.id));
      this.db.prepare(`UPDATE rag_documents SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(nowIso(), nowIso(), documentId);
      void document;
    });
    tx();
  }

  hardDeleteRevision(revisionId: string, options: { allowWithoutCitationStore?: boolean } = {}): void {
    if (!options.allowWithoutCitationStore) {
      throw new Error('Historical revision retention policy is not configured; explicit override required');
    }
    const revision = this.requireRevision(revisionId);
    const document = this.requireDocument(revision.documentId);
    if (document.currentRevisionId === revisionId) throw new Error('Cannot hard-delete the current revision');
    const tx = this.db.transaction(() => {
      for (const space of this.listEmbeddingSpaces()) this.deleteExistingVectorRowsForRevision(space, revisionId);
      this.deleteFtsForRevision(revisionId);
      this.db.prepare('DELETE FROM rag_document_revisions WHERE id = ?').run(revisionId);
    });
    tx();
  }

  hardDeleteDocument(documentId: string, options: { allowWithoutCitationStore?: boolean } = {}): void {
    if (!options.allowWithoutCitationStore) {
      throw new Error('Historical document retention policy is not configured; explicit override required');
    }
    const document = this.requireDocument(documentId);
    const tx = this.db.transaction(() => {
      for (const space of this.listEmbeddingSpaces()) this.deleteExistingVectorRowsForDocument(space, documentId);
      const revisions = this.db.prepare('SELECT id FROM rag_document_revisions WHERE document_id = ?').all(documentId) as Array<{ id: string }>;
      for (const revision of revisions) this.deleteFtsForRevision(String(revision.id));
      this.db.prepare('DELETE FROM rag_documents WHERE id = ?').run(documentId);
    });
    tx();
    void document;
  }

  private revisionId(documentId: string, contentHash: string, extractionVersion: string, chunkingVersion: string, normalizationVersion: string): string {
    return `rev_${sha256(['canonical-revision', documentId, contentHash, extractionVersion, chunkingVersion, normalizationVersion]).slice(0, 32)}`;
  }

  private chunkId(documentId: string, revisionId: string, locator: string, contentHash: string): string {
    return `chunk_${sha256(['canonical-chunk', documentId, revisionId, locator, contentHash]).slice(0, 32)}`;
  }

  private requireDocument(documentId: string): CanonicalRagDocument {
    const document = this.readDocument(documentId);
    if (!document) throw new Error(`Canonical document not found: ${documentId}`);
    return document;
  }

  private requireRevision(revisionId: string): CanonicalRagRevision {
    const revision = this.readRevision(revisionId);
    if (!revision) throw new Error(`Canonical revision not found: ${revisionId}`);
    return revision;
  }

  private requireRevisionForDocument(documentId: string, revisionId: string): CanonicalRagRevision {
    const revision = this.requireRevision(revisionId);
    if (revision.documentId !== documentId) throw new Error('Revision does not belong to document');
    return revision;
  }

  private requireSpace(spaceId: string): CanonicalRagEmbeddingSpace {
    const space = this.readEmbeddingSpace(spaceId);
    if (!space) throw new Error(`Embedding space not found: ${spaceId}`);
    return space;
  }

  private requireJob(jobId: string): CanonicalRagIndexJob {
    const job = this.readJob(jobId);
    if (!job) throw new Error(`Canonical job not found: ${jobId}`);
    return job;
  }

  private ensureStatusRow(documentId: string, revisionId: string, status: CanonicalRagIndexStatus): void {
    this.requireRevisionForDocument(documentId, revisionId);
    this.db.prepare(`
      INSERT OR IGNORE INTO rag_canonical_index_status (
        document_id, revision_id, status, chunk_count, embedded_chunk_count,
        extracted_page_count, total_page_count, error_code, error_message, updated_at
      ) VALUES (?, ?, ?, 0, 0, NULL, NULL, NULL, NULL, ?)
    `).run(documentId, revisionId, status, nowMs());
  }

  private transitionStatus(documentId: string, revisionId: string, next: CanonicalRagIndexStatus): void {
    const current = this.getStatus(documentId, revisionId);
    if (!current) throw new Error('Status row does not exist');
    if (current.status === next) return;
    const allowed = STATUS_TRANSITIONS[current.status];
    if (!allowed.includes(next)) throw new Error(`Invalid canonical RAG status transition: ${current.status} -> ${next}`);
    this.db.prepare(`UPDATE rag_canonical_index_status SET status = ?, updated_at = ? WHERE document_id = ? AND revision_id = ?`)
      .run(next, nowMs(), documentId, revisionId);
  }

  private updateStatusDetails(documentId: string, revisionId: string, details?: Partial<Pick<CanonicalRagIndexStatusRecord, 'chunkCount' | 'embeddedChunkCount' | 'extractedPageCount' | 'totalPageCount' | 'errorCode' | 'errorMessage'>>): CanonicalRagIndexStatusRecord {
    if (details) {
      this.db.prepare(`
        UPDATE rag_canonical_index_status
        SET chunk_count = COALESCE(?, chunk_count),
            embedded_chunk_count = COALESCE(?, embedded_chunk_count),
            extracted_page_count = COALESCE(?, extracted_page_count),
            total_page_count = COALESCE(?, total_page_count),
            error_code = ?, error_message = ?, updated_at = ?
        WHERE document_id = ? AND revision_id = ?
      `).run(details.chunkCount ?? null, details.embeddedChunkCount ?? null,
        details.extractedPageCount ?? null, details.totalPageCount ?? null,
        details.errorCode ?? null, details.errorMessage ?? null, nowMs(), documentId, revisionId);
    }
    return this.getStatus(documentId, revisionId)!;
  }

  readJob(jobId: string): CanonicalRagIndexJob | null {
    const row = this.db.prepare('SELECT * FROM rag_index_jobs WHERE id = ?').get(jobId) as any;
    return row ? this.mapJob(row) : null;
  }

  private deleteFtsForRevision(revisionId: string): void {
    this.db.prepare('DELETE FROM rag_chunks_fts WHERE revision_id = ?').run(revisionId);
  }

  private rebuildFtsForRevision(revisionId: string): number {
    const rows = this.db.prepare(`
      SELECT c.id, c.document_id, c.revision_id, d.source_type, d.name,
             c.heading, c.section, c.text
      FROM rag_chunks c JOIN rag_documents d ON d.id = c.document_id
      WHERE c.revision_id = ?
    `).all(revisionId) as any[];
    const insert = this.db.prepare(`
      INSERT INTO rag_chunks_fts
        (chunk_id, document_id, revision_id, source_type, document_name, heading, section, text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) insert.run(row.id, row.document_id, row.revision_id, row.source_type,
      row.name, row.heading ?? '', row.section ?? '', row.text);
    return rows.length;
  }

  private ensureCanonicalVectorTable(space: CanonicalRagEmbeddingSpace): void {
    assertPositiveInteger(space.dimensions, 'Embedding dimensions');
    const tableName = this.vectorTableName(space.vectorTableKey);
    const existing = this.db.prepare(`SELECT sql FROM sqlite_master WHERE name = ? LIMIT 1`).get(tableName) as { sql: string | null } | undefined;
    if (existing?.sql) {
      const sql = existing.sql.replace(/\s+/g, ' ');
      const dimensionMatch = sql.match(/float\[(\d+)\]/i);
      const metricMatch = sql.match(/distance_metric\s*=\s*(\w+)/i);
      if (!dimensionMatch || Number(dimensionMatch[1]) !== space.dimensions || (metricMatch && metricMatch[1].toLowerCase() !== space.metric)) {
        throw new Error(`Existing canonical vector table ${tableName} does not match embedding space`);
      }
      return;
    }
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE ${tableName} USING vec0(
          embedding float[${space.dimensions}] distance_metric=${space.metric}
        );
      `);
    } catch (error) {
      throw new Error(`Unable to create canonical sqlite-vec table ${tableName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private vectorTableName(vectorTableKey: number): string {
    if (!Number.isInteger(vectorTableKey) || vectorTableKey <= 0) throw new Error('Invalid vector_table_key');
    return `vec_rag_embeddings_${vectorTableKey}`;
  }

  private insertVectorRow(space: CanonicalRagEmbeddingSpace, physicalRowKey: number, vector: Float32Array): void {
    const buffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    this.db.prepare(`
      INSERT INTO ${this.vectorTableName(space.vectorTableKey)} (rowid, embedding)
      VALUES (?, ?)
    `).run(BigInt(physicalRowKey), buffer);
  }

  private deleteVectorRow(space: CanonicalRagEmbeddingSpace, physicalRowKey: number): void {
    this.ensureCanonicalVectorTable(space);
    this.db.prepare(`DELETE FROM ${this.vectorTableName(space.vectorTableKey)} WHERE rowid = ?`).run(BigInt(physicalRowKey));
  }

  private deleteExistingVectorRowsForRevision(space: CanonicalRagEmbeddingSpace, revisionId: string): void {
    if (!this.vectorTableExists(space)) return;
    const rows = this.db.prepare(`
      SELECT e.physical_row_key
      FROM rag_embeddings e JOIN rag_chunks c ON c.id = e.chunk_id
      WHERE c.revision_id = ? AND e.embedding_space_id = ?
    `).all(revisionId, space.id) as Array<{ physical_row_key: number }>;
    for (const row of rows) this.deleteVectorRow(space, Number(row.physical_row_key));
  }

  private deleteExistingVectorRowsForDocument(space: CanonicalRagEmbeddingSpace, documentId: string): void {
    if (!this.vectorTableExists(space)) return;
    const rows = this.db.prepare(`
      SELECT e.physical_row_key
      FROM rag_embeddings e
      JOIN rag_chunks c ON c.id = e.chunk_id
      WHERE c.document_id = ? AND e.embedding_space_id = ?
    `).all(documentId, space.id) as Array<{ physical_row_key: number }>;
    for (const row of rows) this.deleteVectorRow(space, Number(row.physical_row_key));
  }

  private vectorTableExists(space: CanonicalRagEmbeddingSpace): boolean {
    const name = this.vectorTableName(space.vectorTableKey);
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name));
  }

  private mapDocument(row: any): CanonicalRagDocument {
    return {
      id: String(row.id), sourceType: String(row.source_type), sourceId: String(row.source_id),
      ownerId: row.owner_id == null ? null : String(row.owner_id), scopeId: row.scope_id == null ? null : String(row.scope_id),
      name: String(row.name), path: row.path == null ? null : String(row.path),
      mimeType: row.mime_type == null ? null : String(row.mime_type), fileType: row.file_type == null ? null : String(row.file_type),
      sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes), contentHash: row.content_hash == null ? null : String(row.content_hash),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), currentRevisionId: row.current_revision_id == null ? null : String(row.current_revision_id),
      deletedAt: row.deleted_at == null ? null : String(row.deleted_at), metadata: parseJson(row.metadata_json),
    };
  }

  private mapRevision(row: any): CanonicalRagRevision {
    return {
      id: String(row.id), documentId: String(row.document_id), revisionNumber: Number(row.revision_number),
      contentHash: String(row.content_hash), extractionVersion: String(row.extraction_version), chunkingVersion: String(row.chunking_version),
      normalizationVersion: String(row.normalization_version), extractionState: String(row.extraction_state) as CanonicalRagExtractionState,
      createdAt: String(row.created_at), supersededAt: row.superseded_at == null ? null : String(row.superseded_at), metadata: parseJson(row.metadata_json),
    };
  }

  private mapChunk(row: any): CanonicalRagChunk {
    return {
      id: String(row.id), documentId: String(row.document_id), revisionId: String(row.revision_id), chunkIndex: Number(row.chunk_index),
      text: String(row.text), contentHash: String(row.content_hash), pageStart: row.page_start == null ? null : Number(row.page_start),
      pageEnd: row.page_end == null ? null : Number(row.page_end), section: row.section == null ? null : String(row.section), heading: row.heading == null ? null : String(row.heading),
      contentType: row.content_type == null ? null : String(row.content_type), startChar: row.start_char == null ? null : Number(row.start_char),
      endChar: row.end_char == null ? null : Number(row.end_char), tableIndex: row.table_index == null ? null : Number(row.table_index),
      tokenCount: row.token_count == null ? null : Number(row.token_count), speaker: row.speaker == null ? null : String(row.speaker),
      timestampStart: row.timestamp_start == null ? null : Number(row.timestamp_start), timestampEnd: row.timestamp_end == null ? null : Number(row.timestamp_end),
      sourceLocator: row.source_locator == null ? null : String(row.source_locator), metadata: parseJson(row.metadata_json), createdAt: String(row.created_at),
    };
  }

  private mapSpace(row: any): CanonicalRagEmbeddingSpace {
    return {
      id: String(row.id), provider: String(row.provider), model: String(row.model), dimensions: Number(row.dimensions), metric: String(row.metric) as 'cosine',
      version: String(row.version), createdAt: String(row.created_at), retiredAt: row.retired_at == null ? null : String(row.retired_at),
      vectorTableKey: Number(row.vector_table_key), metadata: parseJson(row.metadata_json),
    };
  }

  private mapEmbedding(row: any): CanonicalRagEmbedding {
    const buffer = Buffer.isBuffer(row.vector) ? row.vector : Buffer.from(row.vector);
    const values = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
    return {
      id: String(row.id), chunkId: String(row.chunk_id), embeddingSpaceId: String(row.embedding_space_id), physicalRowKey: Number(row.physical_row_key),
      vector: new Float32Array(values), createdAt: String(row.created_at), metadata: parseJson(row.metadata_json),
    };
  }

  private mapStatus(row: any): CanonicalRagIndexStatusRecord {
    return {
      documentId: String(row.document_id), revisionId: String(row.revision_id), status: String(row.status) as CanonicalRagIndexStatus,
      chunkCount: Number(row.chunk_count), embeddedChunkCount: Number(row.embedded_chunk_count),
      extractedPageCount: row.extracted_page_count == null ? null : Number(row.extracted_page_count), totalPageCount: row.total_page_count == null ? null : Number(row.total_page_count),
      errorCode: row.error_code == null ? null : String(row.error_code), errorMessage: row.error_message == null ? null : String(row.error_message), updatedAt: Number(row.updated_at),
    };
  }

  private mapJob(row: any): CanonicalRagIndexJob {
    return {
      id: String(row.id), documentId: String(row.document_id), revisionId: String(row.revision_id), jobType: String(row.job_type) as CanonicalRagJobType,
      embeddingSpaceId: row.embedding_space_id == null ? null : String(row.embedding_space_id), state: String(row.state) as CanonicalRagJobState,
      attemptCount: Number(row.attempt_count), maxAttempts: Number(row.max_attempts), availableAt: Number(row.available_at),
      leaseUntil: row.lease_until == null ? null : Number(row.lease_until), leasedBy: row.leased_by == null ? null : String(row.leased_by),
      lastError: row.last_error == null ? null : String(row.last_error), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      completedAt: row.completed_at == null ? null : Number(row.completed_at), metadata: parseJson(row.metadata_json),
    };
  }
}
