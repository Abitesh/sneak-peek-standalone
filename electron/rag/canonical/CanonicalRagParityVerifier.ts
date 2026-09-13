/**
 * Change 25 — Phase 4
 * Read-only verification of legacy RAG storage against canonical RAG storage.
 *
 * This verifier never writes either storage system. It compares the current
 * legacy searchable representation with the active canonical revision and
 * explicitly records intentional physical differences.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type {
  ParityAggregateResult,
  ParityComparisonType,
  ParityDiscrepancy,
  ParityResult,
  ParitySourceType,
} from './CanonicalRagParityTypes';

interface LegacyChunk {
  id: string;
  chunkIndex: number;
  text: string;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
  heading: string | null;
  contentType: string | null;
  startChar: number | null;
  endChar: number | null;
  tableIndex: number | null;
  tokenCount: number | null;
  speaker: string | null;
  timestampStart: number | null;
  timestampEnd: number | null;
  metadata: Record<string, unknown>;
  embedding: Buffer | null;
  embeddingProvider: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  embeddingSpace: string | null;
}

interface CanonicalChunk {
  id: string;
  chunkIndex: number;
  text: string;
  contentHash: string;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
  heading: string | null;
  contentType: string | null;
  startChar: number | null;
  endChar: number | null;
  tableIndex: number | null;
  tokenCount: number | null;
  speaker: string | null;
  timestampStart: number | null;
  timestampEnd: number | null;
  sourceLocator: string | null;
  metadata: Record<string, unknown>;
}

interface CanonicalDocument {
  id: string;
  sourceType: string;
  sourceId: string;
  scopeId: string | null;
  name: string;
  path: string | null;
  mimeType: string | null;
  fileType: string | null;
  sizeBytes: number | null;
  contentHash: string | null;
  currentRevisionId: string | null;
  deletedAt: string | null;
  metadata: Record<string, unknown>;
}

interface CanonicalRevision {
  id: string;
  contentHash: string;
  revisionNumber: number;
  extractionState: string;
}

interface LegacyEmbeddingInfo {
  vector: Buffer | null;
  provider: string | null;
  model: string | null;
  dimensions: number | null;
  space: string | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseJson(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((out, key) => {
      out[key] = stableValue((value as Record<string, unknown>)[key]);
      return out;
    }, {});
  }
  return value;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(stableValue(a)) === JSON.stringify(stableValue(b));
}

function bufferToFloat32(buffer: Buffer | null): Float32Array | null {
  if (!buffer || buffer.byteLength === 0 || buffer.byteLength % 4 !== 0) return null;
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

function vectorsEqual(a: Buffer | null, b: Float32Array | null): boolean {
  const av = bufferToFloat32(a);
  if (!av || !b || av.length !== b.length) return false;
  for (let i = 0; i < av.length; i += 1) {
    if (Object.is(av[i], b[i])) continue;
    if (Math.abs(av[i] - b[i]) > 0) return false;
  }
  return true;
}

function vectorHash(buffer: Buffer | null): string | null {
  return buffer ? sha256(buffer.toString('base64')) : null;
}

export class CanonicalRagParityVerifier {
  constructor(private readonly db: Database.Database) {}

  verifyModeFile(fileId: string): ParityResult {
    const legacy = this.db.prepare(`
      SELECT id, mode_id, file_name, content, page_count, extracted_page_count
      FROM mode_reference_files WHERE id = ?
    `).get(fileId) as any;
    if (!legacy) return this.missingSource('mode', fileId, `Legacy Mode file not found: ${fileId}`);

    const result = this.start('mode', fileId);
    const document = this.readCanonicalDocument('mode', fileId);
    if (!document) return this.finish(result, this.missing('mode', fileId, 'document', fileId, null, null, 'Canonical Mode document is missing'));

    this.check(result, 'source.identity', 'semantic', document.sourceId === fileId, fileId, document.id, null,
      fileId, document.sourceId, 'Canonical source identity must point to the legacy Mode file');
    this.check(result, 'mode.scope_id', 'exact', document.scopeId === legacy.mode_id, fileId, document.id, null,
      legacy.mode_id, document.scopeId, 'Mode scope must preserve mode_id');
    this.check(result, 'name', 'exact', document.name === legacy.file_name, fileId, document.id, null,
      legacy.file_name, document.name, 'Mode file name must be preserved');
    this.check(result, 'content_hash', 'semantic', document.contentHash === sha256(legacy.content), fileId, document.id, null,
      sha256(legacy.content), document.contentHash, 'Canonical Mode document hash must represent the legacy file content');

    const revision = this.currentRevision(result, document, fileId);
    if (!revision) return this.finish(result);
    const legacyChunks = this.readModeChunks(fileId);
    const canonicalChunks = this.readCanonicalChunks(revision.id);
    this.compareChunks(result, 'mode', fileId, document.id, revision.id, legacyChunks, canonicalChunks);
    this.compareFts(result, 'mode', fileId, document.id, revision.id, canonicalChunks);
    this.compareLegacyFts(result, 'mode', fileId, document.id, revision.id, canonicalChunks);
    this.compareEmbeddings(result, 'mode', fileId, document.id, revision.id, legacyChunks);
    this.compareStatusAndVectors(result, 'mode', fileId, document.id, revision.id, canonicalChunks);
    return this.finish(result);
  }

  verifyPersonalFile(fileId: string): ParityResult {
    const legacy = this.db.prepare(`
      SELECT id, file_name, file_path, mime_type, size_bytes, content_hash,
             created_at, updated_at, file_type, page_count, extracted_page_count
      FROM personal_files WHERE id = ?
    `).get(fileId) as any;
    if (!legacy) return this.missingSource('personal', fileId, `Legacy personal file not found: ${fileId}`);

    const result = this.start('personal', fileId);
    const document = this.readCanonicalDocument('personal', fileId);
    if (!document) return this.finish(result, this.missing('personal', fileId, 'document', fileId, null, null, 'Canonical personal document is missing'));

    this.check(result, 'source.identity', 'semantic', document.sourceId === fileId, fileId, document.id, null,
      fileId, document.sourceId, 'Canonical source identity must point to the legacy personal file');
    this.check(result, 'name', 'exact', document.name === legacy.file_name, fileId, document.id, null,
      legacy.file_name, document.name, 'Personal file name must be preserved');
    this.check(result, 'path', 'semantic', document.path === legacy.file_path, fileId, document.id, null,
      legacy.file_path, document.path, 'Personal file path must be preserved');
    this.check(result, 'mime_type', 'exact', document.mimeType === legacy.mime_type, fileId, document.id, null,
      legacy.mime_type, document.mimeType, 'Personal MIME type must be preserved');
    this.check(result, 'file_type', 'exact', document.fileType === legacy.file_type, fileId, document.id, null,
      legacy.file_type, document.fileType, 'Personal file type must be preserved');
    this.check(result, 'size_bytes', 'exact', document.sizeBytes === Number(legacy.size_bytes), fileId, document.id, null,
      Number(legacy.size_bytes), document.sizeBytes, 'Personal file size must be preserved');
    this.check(result, 'content_hash', 'exact', document.contentHash === legacy.content_hash, fileId, document.id, null,
      legacy.content_hash, document.contentHash, 'Personal content hash is authoritative in legacy storage');
    this.check(result, 'page_count', 'semantic', document.metadata.pageCount === (legacy.page_count == null ? null : Number(legacy.page_count)), fileId, document.id, null,
      legacy.page_count, document.metadata.pageCount, 'Page count must be preserved in canonical metadata');
    this.check(result, 'extracted_page_count', 'semantic', document.metadata.extractedPageCount === (legacy.extracted_page_count == null ? null : Number(legacy.extracted_page_count)), fileId, document.id, null,
      legacy.extracted_page_count, document.metadata.extractedPageCount, 'Extracted page count must be preserved in canonical metadata');

    const revision = this.currentRevision(result, document, fileId);
    if (!revision) return this.finish(result);
    const legacyChunks = this.readPersonalChunks(fileId);
    const canonicalChunks = this.readCanonicalChunks(revision.id);
    this.compareChunks(result, 'personal', fileId, document.id, revision.id, legacyChunks, canonicalChunks);
    this.compareFts(result, 'personal', fileId, document.id, revision.id, canonicalChunks);
    this.compareLegacyFts(result, 'personal', fileId, document.id, revision.id, canonicalChunks);
    this.compareEmbeddings(result, 'personal', fileId, document.id, revision.id, legacyChunks);
    this.compareStatusAndVectors(result, 'personal', fileId, document.id, revision.id, canonicalChunks);
    return this.finish(result);
  }

  verifyMeeting(meetingId: string): ParityResult {
    if (meetingId === 'live-meeting-current') {
      const result = this.start('meeting', meetingId);
      result.discrepancies.push({
        sourceType: 'meeting',
        sourceId: meetingId,
        field: 'live_meeting',
        comparisonType: 'INTENTIONAL_EXCLUSION',
        severity: 'info',
        reason: 'Live/transient meeting is intentionally excluded from historical Phase 4 parity verification',
        intentional: true,
        verifiable: true,
      });
      return this.finish(result);
    }
    const legacy = this.db.prepare(`
      SELECT id, title, is_processed FROM meetings WHERE id = ?
    `).get(meetingId) as any;
    if (!legacy) return this.missingSource('meeting', meetingId, `Legacy meeting not found: ${meetingId}`);

    const result = this.start('meeting', meetingId);
    const legacyChunks = this.readMeetingChunks(meetingId);
    if (legacyChunks.length === 0) {
      return this.finish(result, this.intentional('meeting', meetingId, 'searchable_content', null, null, null,
        'Meeting has no persisted searchable RAG chunks and is outside Step 3.3 parity scope'));
    }

    const document = this.readCanonicalDocument('meeting', meetingId);
    if (!document) return this.finish(result, this.missing('meeting', meetingId, 'document', meetingId, null, null, 'Canonical meeting projection is missing'));
    this.check(result, 'source.identity', 'exact', document.sourceId === meetingId, meetingId, document.id, null,
      meetingId, document.sourceId, 'Canonical meeting projection must point to meetings.id');

    const revision = this.currentRevision(result, document, meetingId);
    if (!revision) return this.finish(result);
    const canonicalChunks = this.readCanonicalChunks(revision.id);
    this.compareChunks(result, 'meeting', meetingId, document.id, revision.id, legacyChunks, canonicalChunks);
    this.compareFts(result, 'meeting', meetingId, document.id, revision.id, canonicalChunks);
    this.compareLegacyFts(result, 'meeting', meetingId, document.id, revision.id, canonicalChunks);
    this.compareEmbeddings(result, 'meeting', meetingId, document.id, revision.id, legacyChunks);
    this.compareStatusAndVectors(result, 'meeting', meetingId, document.id, revision.id, canonicalChunks);

    // Explicitly document Step 3.3 exclusions without treating them as failures.
    result.discrepancies.push(this.intentional('meeting', meetingId, 'meetings_aggregate', document.id, revision.id, null,
      'Meeting lifecycle aggregate remains outside generic canonical RAG'));
    result.discrepancies.push(this.intentional('meeting', meetingId, 'transcripts', document.id, revision.id, null,
      'Raw transcript rows remain authoritative outside the searchable chunk projection'));
    result.discrepancies.push(this.intentional('meeting', meetingId, 'chunk_summaries', document.id, revision.id, null,
      'Meeting summaries are a separate artifact and are not flattened into transcript chunks'));
    result.discrepancies.push(this.intentional('meeting', meetingId, 'ai_interactions', document.id, revision.id, null,
      'AI interaction history remains outside generic canonical RAG'));
    result.discrepancies.push(this.intentional('meeting', meetingId, 'embedding_queue', document.id, revision.id, null,
      'Legacy embedding queue is not a canonical content representation'));
    return this.finish(result);
  }

  verifyAll(options: {
    modeIds?: readonly string[];
    personalIds?: readonly string[];
    meetingIds?: readonly string[];
  } = {}): ParityAggregateResult {
    const modeIds = options.modeIds ? [...options.modeIds] : (this.db.prepare('SELECT id FROM mode_reference_files ORDER BY id').all() as Array<{ id: string }>).map((r) => String(r.id));
    const personalIds = options.personalIds ? [...options.personalIds] : (this.db.prepare('SELECT id FROM personal_files ORDER BY id').all() as Array<{ id: string }>).map((r) => String(r.id));
    const meetingIds = options.meetingIds ? [...options.meetingIds] : (this.db.prepare("SELECT id FROM meetings WHERE id != 'live-meeting-current' AND COALESCE(is_processed, 0) = 1 AND EXISTS (SELECT 1 FROM chunks c WHERE c.meeting_id = meetings.id) ORDER BY id").all() as Array<{ id: string }>).map((r) => String(r.id));
    const results = [
      ...modeIds.map((id) => this.verifyModeFile(id)),
      ...personalIds.map((id) => this.verifyPersonalFile(id)),
      ...meetingIds.map((id) => this.verifyMeeting(id)),
    ];
    const failed = results.filter((r) => r.status === 'FAIL').length;
    const partial = results.filter((r) => r.status === 'PARTIAL').length;
    const notComparable = results.filter((r) => r.status === 'NOT_COMPARABLE').length;
    return {
      status: failed > 0 ? 'FAIL' : partial > 0 ? 'PARTIAL' : notComparable > 0 ? 'NOT_COMPARABLE' : 'PASS',
      attempted: results.length,
      passed: results.filter((r) => r.status === 'PASS').length,
      failed,
      partial,
      notComparable,
      results,
    };
  }

  private start(sourceType: ParitySourceType, sourceId: string): ParityResult {
    return { sourceType, sourceId, status: 'PASS', checkedFields: 0, discrepancies: [] };
  }

  private finish(result: ParityResult, discrepancy?: ParityDiscrepancy): ParityResult {
    if (discrepancy) result.discrepancies.push(discrepancy);
    const errors = result.discrepancies.filter((d) => d.severity === 'error' && !d.intentional);
    const warnings = result.discrepancies.filter((d) => d.severity === 'warning' && !d.intentional);
    const notComparable = result.discrepancies.some((d) => !d.verifiable && !d.intentional);
    result.status = errors.length > 0 ? 'FAIL' : notComparable ? 'NOT_COMPARABLE' : warnings.length > 0 ? 'PARTIAL' : 'PASS';
    return result;
  }

  private check(
    result: ParityResult,
    field: string,
    comparison: 'exact' | 'semantic',
    equal: boolean,
    sourceId: string,
    canonicalDocumentId: string,
    canonicalRevisionId: string | null,
    expectedValue: unknown,
    actualValue: unknown,
    reason: string,
    legacyChunkId?: string | null,
    canonicalChunkId?: string | null,
  ): void {
    result.checkedFields += 1;
    if (equal) return;
    result.discrepancies.push({
      sourceType: result.sourceType,
      sourceId,
      legacyDocumentId: sourceId,
      legacyChunkId: legacyChunkId ?? null,
      canonicalDocumentId,
      canonicalRevisionId,
      canonicalChunkId: canonicalChunkId ?? null,
      field,
      expectedValue,
      actualValue,
      comparisonType: comparison === 'exact' ? 'EXACT' : 'SEMANTIC',
      severity: 'error',
      reason,
      intentional: false,
      verifiable: true,
    });
  }

  private missing(
    sourceType: ParitySourceType,
    sourceId: string,
    field: string,
    legacyDocumentId: string | null,
    canonicalDocumentId: string | null,
    canonicalRevisionId: string | null,
    reason: string,
  ): ParityDiscrepancy {
    return {
      sourceType,
      sourceId,
      legacyDocumentId,
      canonicalDocumentId,
      canonicalRevisionId,
      field,
      comparisonType: 'MISSING',
      severity: 'error',
      reason,
      intentional: false,
      verifiable: true,
    };
  }

  private intentional(
    sourceType: ParitySourceType,
    sourceId: string,
    field: string,
    canonicalDocumentId: string | null,
    canonicalRevisionId: string | null,
    canonicalChunkId: string | null,
    reason: string,
  ): ParityDiscrepancy {
    return {
      sourceType,
      sourceId,
      canonicalDocumentId,
      canonicalRevisionId,
      canonicalChunkId,
      field,
      comparisonType: 'INTENTIONAL_EXCLUSION',
      severity: 'info',
      reason,
      intentional: true,
      verifiable: true,
    };
  }

  private missingSource(sourceType: ParitySourceType, sourceId: string, reason: string): ParityResult {
    return this.finish(this.start(sourceType, sourceId), this.missing(sourceType, sourceId, 'source', sourceId, null, null, reason));
  }

  private currentRevision(result: ParityResult, document: CanonicalDocument, sourceId: string): CanonicalRevision | null {
    if (!document.currentRevisionId) {
      result.discrepancies.push(this.missing(result.sourceType, sourceId, 'current_revision_id', sourceId, document.id, null, 'Canonical document has no active revision'));
      return null;
    }
    const revision = this.db.prepare(`SELECT id, content_hash, revision_number, extraction_state FROM rag_document_revisions WHERE id = ?`).get(document.currentRevisionId) as any;
    if (!revision) {
      result.discrepancies.push(this.missing(result.sourceType, sourceId, 'revision', sourceId, document.id, document.currentRevisionId, 'Canonical current revision is missing'));
      return null;
    }
    return {
      id: String(revision.id),
      contentHash: String(revision.content_hash),
      revisionNumber: Number(revision.revision_number),
      extractionState: String(revision.extraction_state),
    };
  }

  private readCanonicalDocument(sourceType: ParitySourceType, sourceId: string): CanonicalDocument | null {
    const row = this.db.prepare('SELECT * FROM rag_documents WHERE source_type = ? AND source_id = ? LIMIT 1').get(sourceType, sourceId) as any;
    if (!row) return null;
    return {
      id: String(row.id), sourceType: String(row.source_type), sourceId: String(row.source_id),
      scopeId: row.scope_id == null ? null : String(row.scope_id), name: String(row.name),
      path: row.path == null ? null : String(row.path), mimeType: row.mime_type == null ? null : String(row.mime_type),
      fileType: row.file_type == null ? null : String(row.file_type), sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
      contentHash: row.content_hash == null ? null : String(row.content_hash), currentRevisionId: row.current_revision_id == null ? null : String(row.current_revision_id),
      deletedAt: row.deleted_at == null ? null : String(row.deleted_at), metadata: parseJson(row.metadata_json),
    };
  }

  private readCanonicalChunks(revisionId: string): CanonicalChunk[] {
    return (this.db.prepare('SELECT * FROM rag_chunks WHERE revision_id = ? ORDER BY chunk_index ASC').all(revisionId) as any[]).map((row) => ({
      id: String(row.id), chunkIndex: Number(row.chunk_index), text: String(row.text), contentHash: String(row.content_hash),
      pageStart: row.page_start == null ? null : Number(row.page_start), pageEnd: row.page_end == null ? null : Number(row.page_end),
      section: row.section == null ? null : String(row.section), heading: row.heading == null ? null : String(row.heading),
      contentType: row.content_type == null ? null : String(row.content_type), startChar: row.start_char == null ? null : Number(row.start_char),
      endChar: row.end_char == null ? null : Number(row.end_char), tableIndex: row.table_index == null ? null : Number(row.table_index),
      tokenCount: row.token_count == null ? null : Number(row.token_count), speaker: row.speaker == null ? null : String(row.speaker),
      timestampStart: row.timestamp_start == null ? null : Number(row.timestamp_start), timestampEnd: row.timestamp_end == null ? null : Number(row.timestamp_end),
      sourceLocator: row.source_locator == null ? null : String(row.source_locator), metadata: parseJson(row.metadata_json),
    }));
  }

  private readModeChunks(fileId: string): LegacyChunk[] {
    return (this.db.prepare(`SELECT id, chunk_index, text, embedding, embedding_space, page_start, page_end, section, heading, content_type, table_index, metadata_json FROM mode_reference_chunks WHERE file_id = ? ORDER BY chunk_index ASC`).all(fileId) as any[]).map((row) => ({
      id: String(row.id), chunkIndex: Number(row.chunk_index), text: String(row.text), pageStart: row.page_start == null ? null : Number(row.page_start), pageEnd: row.page_end == null ? null : Number(row.page_end),
      section: row.section == null ? null : String(row.section), heading: row.heading == null ? null : String(row.heading), contentType: row.content_type == null ? null : String(row.content_type),
      startChar: null, endChar: null, tableIndex: row.table_index == null ? null : Number(row.table_index), tokenCount: null, speaker: null, timestampStart: null, timestampEnd: null,
      metadata: parseJson(row.metadata_json), embedding: row.embedding ?? null, embeddingProvider: null, embeddingModel: null, embeddingDimensions: row.embedding ? Math.floor(row.embedding.length / 4) : null, embeddingSpace: row.embedding_space ?? null,
    }));
  }

  private readPersonalChunks(fileId: string): LegacyChunk[] {
    return (this.db.prepare(`SELECT id, chunk_index, text, start_char, end_char, page_start, page_end, section, heading, content_type, metadata_json, embedding, embedding_provider, embedding_dimensions, embedding_space FROM personal_file_chunks WHERE file_id = ? ORDER BY chunk_index ASC`).all(fileId) as any[]).map((row) => ({
      id: String(row.id), chunkIndex: Number(row.chunk_index), text: String(row.text), pageStart: row.page_start == null ? null : Number(row.page_start), pageEnd: row.page_end == null ? null : Number(row.page_end),
      section: row.section == null ? null : String(row.section), heading: row.heading == null ? null : String(row.heading), contentType: row.content_type == null ? null : String(row.content_type),
      startChar: Number(row.start_char), endChar: Number(row.end_char), tableIndex: null, tokenCount: null, speaker: null, timestampStart: null, timestampEnd: null,
      metadata: parseJson(row.metadata_json), embedding: row.embedding ?? null, embeddingProvider: row.embedding_provider ?? null, embeddingModel: null, embeddingDimensions: row.embedding_dimensions == null ? null : Number(row.embedding_dimensions), embeddingSpace: row.embedding_space ?? null,
    }));
  }

  private readMeetingChunks(meetingId: string): LegacyChunk[] {
    return (this.db.prepare(`SELECT id, chunk_index, speaker, start_timestamp_ms, end_timestamp_ms, cleaned_text, token_count, embedding FROM chunks WHERE meeting_id = ? ORDER BY chunk_index ASC`).all(meetingId) as any[]).map((row) => ({
      id: String(row.id), chunkIndex: Number(row.chunk_index), text: String(row.cleaned_text), pageStart: null, pageEnd: null, section: null, heading: null,
      contentType: 'meeting-transcript-chunk', startChar: null, endChar: null, tableIndex: null, tokenCount: Number(row.token_count), speaker: row.speaker == null ? null : String(row.speaker),
      timestampStart: row.start_timestamp_ms == null ? null : Number(row.start_timestamp_ms), timestampEnd: row.end_timestamp_ms == null ? null : Number(row.end_timestamp_ms), metadata: { meetingId, tokenCount: Number(row.token_count) },
      embedding: row.embedding ?? null, embeddingProvider: null, embeddingModel: null, embeddingDimensions: row.embedding ? Math.floor(row.embedding.length / 4) : null, embeddingSpace: null,
    }));
  }

  private compareChunks(result: ParityResult, sourceType: ParitySourceType, sourceId: string, documentId: string, revisionId: string, legacy: LegacyChunk[], canonical: CanonicalChunk[]): void {
    result.checkedFields += 1;
    if (legacy.length !== canonical.length) {
      result.discrepancies.push({ sourceType, sourceId, field: 'chunk_count', expectedValue: legacy.length, actualValue: canonical.length, comparisonType: 'EXACT', severity: 'error', reason: 'Legacy and canonical current searchable chunk counts differ', intentional: false, verifiable: true, legacyDocumentId: sourceId, canonicalDocumentId: documentId, canonicalRevisionId: revisionId });
    }
    const count = Math.min(legacy.length, canonical.length);
    for (let i = 0; i < count; i += 1) {
      const l = legacy[i];
      const c = canonical[i];
      const checks: Array<[string, unknown, unknown]> = [
        ['chunk_index', l.chunkIndex, c.chunkIndex], ['text', l.text, c.text], ['content_hash', sha256(l.text), c.contentHash],
        ['page_start', l.pageStart, c.pageStart], ['page_end', l.pageEnd, c.pageEnd], ['section', l.section, c.section], ['heading', l.heading, c.heading],
        ['content_type', l.contentType, c.contentType], ['start_char', l.startChar, c.startChar], ['end_char', l.endChar, c.endChar],
        ['table_index', l.tableIndex, c.tableIndex], ['token_count', l.tokenCount, c.tokenCount], ['speaker', l.speaker, c.speaker],
        ['timestamp_start', l.timestampStart, c.timestampStart], ['timestamp_end', l.timestampEnd, c.timestampEnd],
      ];
      for (const [field, expected, actual] of checks) {
        result.checkedFields += 1;
        if (expected === actual) continue;
        result.discrepancies.push({ sourceType, sourceId, legacyDocumentId: sourceId, legacyChunkId: l.id, canonicalDocumentId: documentId, canonicalRevisionId: revisionId, canonicalChunkId: c.id, field, expectedValue: expected, actualValue: actual, comparisonType: 'EXACT', severity: 'error', reason: `Legacy and canonical chunk ${field} differ`, intentional: false, verifiable: true });
      }
      result.checkedFields += 1;
      const legacyId = String(l.id);
      const metadataLegacyId = c.metadata.legacyChunkId;
      if (String(metadataLegacyId) !== legacyId) {
        result.discrepancies.push({ sourceType, sourceId, legacyDocumentId: sourceId, legacyChunkId: l.id, canonicalDocumentId: documentId, canonicalRevisionId: revisionId, canonicalChunkId: c.id, field: 'metadata.legacyChunkId', expectedValue: legacyId, actualValue: metadataLegacyId, comparisonType: 'SEMANTIC', severity: 'error', reason: 'Legacy chunk identity must be retained as provenance metadata', intentional: false, verifiable: true });
      }
      result.checkedFields += 1;
      const expectedMetadata = { ...l.metadata };
      delete expectedMetadata.legacyChunkId;
      delete expectedMetadata.legacyFileId;
      delete expectedMetadata.legacyDocumentId;
      delete expectedMetadata.migrationSource;
      delete expectedMetadata.searchableProjection;
      delete expectedMetadata.contentType;
      delete expectedMetadata.tokenCount;
      const actualMetadata = { ...c.metadata };
      delete actualMetadata.legacyChunkId;
      delete actualMetadata.legacyFileId;
      delete actualMetadata.legacyDocumentId;
      delete actualMetadata.migrationSource;
      delete actualMetadata.searchableProjection;
      delete actualMetadata.contentType;
      delete actualMetadata.tokenCount;
      if (!sameJson(expectedMetadata, actualMetadata)) {
        result.discrepancies.push({ sourceType, sourceId, legacyDocumentId: sourceId, legacyChunkId: l.id, canonicalDocumentId: documentId, canonicalRevisionId: revisionId, canonicalChunkId: c.id, field: 'metadata', expectedValue: expectedMetadata, actualValue: actualMetadata, comparisonType: 'SEMANTIC', severity: 'error', reason: 'Legacy metadata is not semantically preserved in canonical chunk metadata', intentional: false, verifiable: true });
      }
      result.discrepancies.push({ sourceType, sourceId, legacyDocumentId: sourceId, legacyChunkId: l.id, canonicalDocumentId: documentId, canonicalRevisionId: revisionId, canonicalChunkId: c.id, field: 'chunk.id', expectedValue: l.id, actualValue: c.id, comparisonType: 'DERIVED', severity: 'info', reason: 'Canonical chunk ID is intentionally deterministic and different from the legacy chunk ID', intentional: true, verifiable: true });
    }
  }

  private compareFts(result: ParityResult, sourceType: ParitySourceType, sourceId: string, documentId: string, revisionId: string, canonicalChunks: CanonicalChunk[]): void {
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rag_chunks_fts' LIMIT 1").get();
    if (!exists) {
      result.discrepancies.push({ sourceType, sourceId, field: 'canonical_fts', comparisonType: 'NOT_COMPARABLE', severity: 'warning', reason: 'Canonical FTS table is unavailable', intentional: false, verifiable: false });
      return;
    }
    const rows = this.db.prepare('SELECT chunk_id, document_id, revision_id, source_type, document_name, heading, section, text FROM rag_chunks_fts WHERE revision_id = ? ORDER BY chunk_id').all(revisionId) as any[];
    result.checkedFields += 1;
    if (rows.length !== canonicalChunks.length) {
      result.discrepancies.push({ sourceType, sourceId, legacyDocumentId: sourceId, canonicalDocumentId: documentId, canonicalRevisionId: revisionId, field: 'canonical_fts.row_count', expectedValue: canonicalChunks.length, actualValue: rows.length, comparisonType: 'SEMANTIC', severity: 'error', reason: 'Canonical FTS must cover every canonical chunk exactly once', intentional: false, verifiable: true });
    }
    const byChunk = new Map(rows.map((r) => [String(r.chunk_id), r]));
    for (const chunk of canonicalChunks) {
      const row = byChunk.get(chunk.id);
      result.checkedFields += 1;
      if (!row) {
        result.discrepancies.push({ sourceType, sourceId, legacyDocumentId: sourceId, canonicalDocumentId: documentId, canonicalRevisionId: revisionId, canonicalChunkId: chunk.id, field: 'canonical_fts.chunk', comparisonType: 'MISSING', severity: 'error', reason: 'Canonical FTS row is missing', intentional: false, verifiable: true });
        continue;
      }
      const checks: Array<[string, unknown, unknown]> = [
        ['document_id', documentId, String(row.document_id)], ['revision_id', revisionId, String(row.revision_id)], ['source_type', sourceType, String(row.source_type)],
        ['document_name', String((this.db.prepare('SELECT name FROM rag_documents WHERE id = ?').get(documentId) as { name?: string } | undefined)?.name ?? ''), String(row.document_name)], ['heading', chunk.heading ?? '', String(row.heading ?? '')], ['section', chunk.section ?? '', String(row.section ?? '')], ['text', chunk.text, String(row.text)],
      ];
      for (const [field, expected, actual] of checks) {
        result.checkedFields += 1;
        if (expected === actual) continue;
        result.discrepancies.push({ sourceType, sourceId, legacyDocumentId: sourceId, canonicalDocumentId: documentId, canonicalRevisionId: revisionId, canonicalChunkId: chunk.id, field: `fts.${field}`, expectedValue: expected, actualValue: actual, comparisonType: 'SEMANTIC', severity: 'error', reason: 'Canonical FTS searchable content differs from canonical chunk content', intentional: false, verifiable: true });
      }
    }
  }

  private compareLegacyFts(result: ParityResult, sourceType: ParitySourceType, sourceId: string, documentId: string, revisionId: string, canonicalChunks: CanonicalChunk[]): void {
    const table = sourceType === 'mode' ? 'mode_reference_chunks_fts' : sourceType === 'personal' ? 'personal_file_chunks_fts' : 'chunks_fts';
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1").get(table);
    if (!exists) {
      result.discrepancies.push({ sourceType, sourceId, canonicalDocumentId: documentId, canonicalRevisionId: revisionId, field: 'legacy_fts', comparisonType: 'NOT_COMPARABLE', severity: 'warning', reason: `Legacy FTS table ${table} is unavailable`, intentional: false, verifiable: false });
      return;
    }
    const countSql = sourceType === 'mode'
      ? 'SELECT COUNT(*) AS n FROM mode_reference_chunks_fts WHERE file_id = ?'
      : sourceType === 'personal'
        ? 'SELECT COUNT(*) AS n FROM personal_file_chunks_fts WHERE file_id = ?'
        : 'SELECT COUNT(*) AS n FROM chunks_fts WHERE meeting_id = ?';
    const row = this.db.prepare(countSql).get(sourceId) as { n: number };
    result.checkedFields += 1;
    if (Number(row.n) !== canonicalChunks.length) {
      result.discrepancies.push({ sourceType, sourceId, legacyDocumentId: sourceId, canonicalDocumentId: documentId, canonicalRevisionId: revisionId, field: 'legacy_fts.row_count', expectedValue: canonicalChunks.length, actualValue: Number(row.n), comparisonType: 'SEMANTIC', severity: 'error', reason: 'Legacy FTS does not cover the same searchable chunk count as canonical content', intentional: false, verifiable: true });
    }
    const textRows = sourceType === 'mode'
      ? this.db.prepare('SELECT chunk_id, text FROM mode_reference_chunks_fts WHERE file_id = ? ORDER BY CAST(chunk_id AS INTEGER)').all(sourceId) as any[]
      : sourceType === 'personal'
        ? this.db.prepare('SELECT chunk_id, text FROM personal_file_chunks_fts WHERE file_id = ? ORDER BY chunk_id').all(sourceId) as any[]
        : this.db.prepare('SELECT chunk_id, text FROM chunks_fts WHERE meeting_id = ? ORDER BY CAST(chunk_id AS INTEGER)').all(sourceId) as any[];
    const legacyTexts = textRows.map((r) => String(r.text));
    const canonicalTexts = canonicalChunks.map((c) => c.text);
    result.checkedFields += 1;
    if (JSON.stringify(legacyTexts.sort()) !== JSON.stringify(canonicalTexts.slice().sort())) {
      result.discrepancies.push({ sourceType, sourceId, legacyDocumentId: sourceId, canonicalDocumentId: documentId, canonicalRevisionId: revisionId, field: 'legacy_fts.text', comparisonType: 'SEMANTIC', severity: 'error', reason: 'Legacy FTS searchable text set differs from canonical chunk text set', intentional: false, verifiable: true });
    }
  }

  private compareEmbeddings(result: ParityResult, sourceType: ParitySourceType, sourceId: string, documentId: string, revisionId: string, legacyChunks: LegacyChunk[]): void {
    const rows = this.db.prepare(`SELECT e.id, e.chunk_id, e.embedding_space_id, e.vector, s.provider, s.model, s.dimensions, s.version FROM rag_embeddings e JOIN rag_chunks c ON c.id = e.chunk_id JOIN rag_embedding_spaces s ON s.id = e.embedding_space_id WHERE c.revision_id = ? ORDER BY c.chunk_index`).all(revisionId) as any[];
    const canonicalByChunk = new Map(rows.map((r) => [String(r.chunk_id), r]));
    const canonicalChunks = this.readCanonicalChunks(revisionId);
    for (let i = 0; i < Math.min(legacyChunks.length, canonicalChunks.length); i += 1) {
      const legacy = legacyChunks[i];
      const canonicalChunk = canonicalChunks[i];
      const canonical = canonicalByChunk.get(canonicalChunk.id);
      result.checkedFields += 1;
      if (!canonical) {
        result.discrepancies.push({ sourceType, sourceId, legacyDocumentId: sourceId, legacyChunkId: legacy.id, canonicalDocumentId: documentId, canonicalRevisionId: revisionId, canonicalChunkId: canonicalChunk.id, field: 'embedding', comparisonType: 'MISSING', severity: 'error', reason: 'Canonical embedding is missing for a migrated chunk', intentional: false, verifiable: true });
        continue;
      }
      const legacyInfo: LegacyEmbeddingInfo = { vector: legacy.embedding, provider: legacy.embeddingProvider, model: legacy.embeddingModel, dimensions: legacy.embeddingDimensions, space: legacy.embeddingSpace };
      const canonicalVector = Buffer.isBuffer(canonical.vector) ? canonical.vector : Buffer.from(canonical.vector);
      const legacyVector = bufferToFloat32(legacyInfo.vector);
      const canonicalValues = bufferToFloat32(canonicalVector);
      if (legacyVector && canonicalValues && vectorsEqual(legacyInfo.vector, canonicalValues)) {
        result.discrepancies.push({ sourceType, sourceId, legacyDocumentId: sourceId, legacyChunkId: legacy.id, canonicalDocumentId: documentId, canonicalRevisionId: revisionId, canonicalChunkId: canonicalChunk.id, field: 'embedding.vector', expectedValue: vectorHash(legacyInfo.vector), actualValue: vectorHash(canonicalVector), comparisonType: 'EXACT', severity: 'info', reason: 'Legacy embedding vector is exactly represented by canonical embedding storage', intentional: false, verifiable: true });
      } else if (legacyVector && canonicalValues) {
        const hasRecoverableIdentity = legacyInfo.provider != null && legacyInfo.dimensions != null || legacyInfo.space != null;
        if (sourceType === 'meeting' && !hasRecoverableIdentity) {
          result.discrepancies.push({ sourceType, sourceId, legacyDocumentId: sourceId, legacyChunkId: legacy.id, canonicalDocumentId: documentId, canonicalRevisionId: revisionId, canonicalChunkId: canonicalChunk.id, field: 'embedding.vector', comparisonType: 'INTENTIONAL_EXCLUSION', severity: 'info', reason: 'Meeting embeddings are intentionally re-generated during canonical backfill because the legacy meeting embedding provider/space identity is not reliably recoverable', intentional: true, verifiable: true });
        } else {
          const sameKnownIdentity = legacyInfo.provider != null && legacyInfo.dimensions != null
            ? String(canonical.provider) === legacyInfo.provider && Number(canonical.dimensions) === legacyInfo.dimensions
            : legacyInfo.space != null && String(canonical.model) === legacyInfo.space && Number(canonical.dimensions) === legacyVector.length;
          result.discrepancies.push({ sourceType, sourceId, legacyDocumentId: sourceId, legacyChunkId: legacy.id, canonicalDocumentId: documentId, canonicalRevisionId: revisionId, canonicalChunkId: canonicalChunk.id, field: 'embedding.vector', comparisonType: sameKnownIdentity ? 'SEMANTIC' : 'DIFFERENT_SPACE', severity: sameKnownIdentity ? 'warning' : 'error', reason: sameKnownIdentity ? 'Embedding values differ, but the recoverable provider/dimension identity is compatible' : 'Legacy and canonical embedding vectors cannot be treated as the same embedding space', intentional: false, verifiable: true });
        }
      } else if (!legacyVector) {
        if (sourceType === 'meeting') {
          result.discrepancies.push({ sourceType, sourceId, legacyDocumentId: sourceId, legacyChunkId: legacy.id, canonicalDocumentId: documentId, canonicalRevisionId: revisionId, canonicalChunkId: canonicalChunk.id, field: 'embedding.vector', comparisonType: 'INTENTIONAL_EXCLUSION', severity: 'info', reason: 'Meeting embeddings are intentionally re-generated during canonical backfill because the legacy meeting embedding provider/space identity is not reliably recoverable', intentional: true, verifiable: true });
        } else {
          result.discrepancies.push({ sourceType, sourceId, legacyDocumentId: sourceId, legacyChunkId: legacy.id, canonicalDocumentId: documentId, canonicalRevisionId: revisionId, canonicalChunkId: canonicalChunk.id, field: 'embedding.vector', comparisonType: 'NOT_COMPARABLE', severity: 'warning', reason: 'Legacy embedding is missing or not a valid Float32 vector; canonical embedding cannot be numerically compared', intentional: false, verifiable: false });
        }
      }
      if (legacyInfo.space && sourceType === 'mode') {
        const compatible = String(canonical.model) === legacyInfo.space && Number(canonical.dimensions) === Number(legacyInfo.dimensions);
        result.checkedFields += 1;
        if (!compatible) {
          result.discrepancies.push({ sourceType, sourceId, legacyDocumentId: sourceId, legacyChunkId: legacy.id, canonicalDocumentId: documentId, canonicalRevisionId: revisionId, canonicalChunkId: canonicalChunk.id, field: 'embedding.space', expectedValue: legacyInfo.space, actualValue: `${canonical.provider}:${canonical.model}:${canonical.dimensions}:${canonical.version}`, comparisonType: 'DIFFERENT_SPACE', severity: 'error', reason: 'Mode legacy embedding space was not preserved as the canonical embedding space', intentional: false, verifiable: true });
        }
      }
    }
  }

  private compareStatusAndVectors(result: ParityResult, sourceType: ParitySourceType, sourceId: string, documentId: string, revisionId: string, canonicalChunks: CanonicalChunk[]): void {
    const status = this.db.prepare('SELECT status, chunk_count, embedded_chunk_count FROM rag_canonical_index_status WHERE document_id = ? AND revision_id = ?').get(documentId, revisionId) as any;
    result.checkedFields += 1;
    if (!status) {
      result.discrepancies.push(this.missing(sourceType, sourceId, 'canonical_status', sourceId, documentId, revisionId, 'Canonical revision status is missing'));
      return;
    }
    result.checkedFields += 1;
    if (String(status.status) !== 'READY') {
      result.discrepancies.push({ sourceType, sourceId, legacyDocumentId: sourceId, canonicalDocumentId: documentId, canonicalRevisionId: revisionId, field: 'canonical_status', expectedValue: 'READY', actualValue: status.status, comparisonType: 'SEMANTIC', severity: 'error', reason: 'Parity requires a fully indexed canonical current revision', intentional: false, verifiable: true });
    }
    result.checkedFields += 1;
    if (Number(status.chunk_count) !== canonicalChunks.length) {
      result.discrepancies.push({ sourceType, sourceId, legacyDocumentId: sourceId, canonicalDocumentId: documentId, canonicalRevisionId: revisionId, field: 'canonical_status.chunk_count', expectedValue: canonicalChunks.length, actualValue: Number(status.chunk_count), comparisonType: 'EXACT', severity: 'error', reason: 'Canonical status chunk count does not match canonical chunk storage', intentional: false, verifiable: true });
    }
    const spaces = this.db.prepare(`SELECT DISTINCT e.embedding_space_id AS id FROM rag_embeddings e JOIN rag_chunks c ON c.id = e.chunk_id WHERE c.revision_id = ?`).all(revisionId) as Array<{ id: string }>;
    for (const row of spaces) {
      const report = this.checkCanonicalVectorSpace(String(row.id), revisionId);
      result.checkedFields += 1;
      if (report.missing > 0 || report.orphan > 0 || report.dimensionMismatch > 0) {
        result.discrepancies.push({ sourceType, sourceId, legacyDocumentId: sourceId, canonicalDocumentId: documentId, canonicalRevisionId: revisionId, field: 'canonical_vector_index', expectedValue: { missing: 0, orphan: 0, dimensionMismatch: 0 }, actualValue: report, comparisonType: 'SEMANTIC', severity: 'error', reason: 'Canonical vector index does not reconcile with canonical embeddings', intentional: false, verifiable: true });
      }
    }
  }

  private checkCanonicalVectorSpace(spaceId: string, revisionId: string): { missing: number; orphan: number; dimensionMismatch: number } {
    const space = this.db.prepare('SELECT vector_table_key, dimensions FROM rag_embedding_spaces WHERE id = ?').get(spaceId) as any;
    if (!space) return { missing: 0, orphan: 0, dimensionMismatch: 0 };
    const table = `vec_rag_embeddings_${Number(space.vector_table_key)}`;
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1").get(table);
    if (!exists) return { missing: 1, orphan: 0, dimensionMismatch: 0 };
    // sqlite-vec tables are scoped to the embedding space, not to one
    // document/revision. A single space can legitimately contain vectors for
    // many migrated sources. Therefore orphan detection must reconcile the
    // physical table against every canonical embedding in the space, while
    // missing-row detection remains scoped to the revision being verified.
    const allEmbeddings = this.db.prepare(`
      SELECT physical_row_key, vector, chunk_id
      FROM rag_embeddings
      WHERE embedding_space_id = ?
    `).all(spaceId) as any[];
    const revisionEmbeddings = allEmbeddings.filter((row) => {
      const chunk = this.db.prepare('SELECT revision_id FROM rag_chunks WHERE id = ?').get(row.chunk_id) as { revision_id?: string } | undefined;
      return chunk?.revision_id === revisionId;
    });
    const keys = new Set(allEmbeddings.map((r) => Number(r.physical_row_key)));
    const rows = this.db.prepare(`SELECT rowid FROM ${table}`).all() as Array<{ rowid: number | bigint }>;
    const vectorKeys = new Set(rows.map((r) => Number(r.rowid)));
    let missing = 0;
    let dimensionMismatch = 0;
    for (const row of revisionEmbeddings) {
      if (!vectorKeys.has(Number(row.physical_row_key))) missing += 1;
      const vector = bufferToFloat32(Buffer.isBuffer(row.vector) ? row.vector : Buffer.from(row.vector));
      if (!vector || vector.length !== Number(space.dimensions)) dimensionMismatch += 1;
    }
    for (const row of allEmbeddings) {
      const vector = bufferToFloat32(Buffer.isBuffer(row.vector) ? row.vector : Buffer.from(row.vector));
      if (!vector || vector.length !== Number(space.dimensions)) dimensionMismatch += 1;
    }
    let orphan = 0;
    for (const row of rows) if (!keys.has(Number(row.rowid))) orphan += 1;
    return { missing, orphan, dimensionMismatch };
  }
}
