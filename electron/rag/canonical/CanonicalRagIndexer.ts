/**
 * Change 25 — Step 3.0
 * Universal canonical RAG indexing engine.
 *
 * This service operates only on canonical RAG entities. Source-specific
 * ingestion and retrieval remain outside this boundary.
 */

import { randomUUID } from 'node:crypto';
import { CanonicalEmbeddingService } from './CanonicalEmbeddingService';
import type {
  CanonicalChunkInput,
  CanonicalRagIndexJob,
  CanonicalRagIndexStatus,
} from './CanonicalRagTypes';
import { CanonicalRagStorage } from './CanonicalRagStorage';

export interface CanonicalIndexRunOptions {
  embeddingSpaceId?: string;
  batchSize?: number;
  activate?: boolean;
  workerId?: string;
  maxAttempts?: number;
}

export interface CanonicalIndexRunResult {
  documentId: string;
  revisionId: string;
  embeddingSpaceId: string;
  chunkCount: number;
  embeddedChunkCount: number;
  complete: boolean;
  activated: boolean;
}

const DEFAULT_WORKER_PREFIX = 'canonical-indexer';

export interface CanonicalSourceCorpusInput {
  sourceType: string;
  sourceId: string;
  name: string;
  contentHash: string;
  chunks: readonly CanonicalChunkInput[];
  extractionVersion: string;
  chunkingVersion: string;
  normalizationVersion: string;
  path?: string | null;
  mimeType?: string | null;
  fileType?: string | null;
  scopeId?: string | null;
  sizeBytes?: number | null;
  metadata?: Record<string, unknown>;
}

/**
 * Runs the canonical indexing lifecycle for one already-materialized revision.
 * Extraction and source-specific chunking are intentionally outside this
 * service: the input contract is a canonical document/revision/chunk set.
 */
export class CanonicalRagIndexer {
  constructor(
    private readonly storage: CanonicalRagStorage,
    private readonly embeddingService: CanonicalEmbeddingService,
  ) {}

  /**
   * Change 25 Phase 9: index an in-memory canonical corpus without reading
   * legacy tables. Used when canonical reads are already authoritative so new
   * documents do not need a legacy write first.
   */
  async indexSourceCorpus(
    input: CanonicalSourceCorpusInput,
    options: CanonicalIndexRunOptions = {},
  ): Promise<CanonicalIndexRunResult> {
    if (!input.chunks.length) throw new Error('Canonical source corpus requires chunks');

    const document = this.storage.createDocument({
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      name: input.name,
      path: input.path ?? null,
      mimeType: input.mimeType ?? null,
      fileType: input.fileType ?? null,
      scopeId: input.scopeId ?? null,
      sizeBytes: input.sizeBytes ?? null,
      contentHash: input.contentHash,
      metadata: input.metadata ?? {},
    });

    this.storage.updateDocument(document.id, {
      name: input.name,
      path: input.path ?? document.path,
      mimeType: input.mimeType ?? document.mimeType,
      fileType: input.fileType ?? document.fileType,
      sizeBytes: input.sizeBytes ?? document.sizeBytes,
      contentHash: input.contentHash,
      metadata: { ...document.metadata, ...(input.metadata ?? {}) },
    });

    const revision = this.storage.createRevision({
      documentId: document.id,
      contentHash: input.contentHash,
      extractionVersion: input.extractionVersion,
      chunkingVersion: input.chunkingVersion,
      normalizationVersion: input.normalizationVersion,
      extractionState: 'EXTRACTED',
      metadata: input.metadata ?? {},
    });

    const existingStatus = this.storage.getStatus(document.id, revision.id);
    if (!existingStatus || !['READY', 'EMBEDDING'].includes(existingStatus.status)) {
      this.storage.replaceChunks(document.id, revision.id, input.chunks);
    }

    return this.indexRevision(revision.id, { ...options, activate: options.activate ?? true });
  }

  async indexRevision(
    revisionId: string,
    options: CanonicalIndexRunOptions = {},
  ): Promise<CanonicalIndexRunResult> {
    const revision = this.storage.readRevision(revisionId);
    if (!revision) throw new Error(`Canonical revision not found: ${revisionId}`);

    const document = this.storage.readDocument(revision.documentId);
    if (!document) throw new Error(`Canonical document not found: ${revision.documentId}`);
    if (document.deletedAt) throw new Error('Cannot index a deleted canonical document');

    let status = this.storage.getStatus(document.id, revision.id);
    if (!status) {
      status = this.storage.setStatus(document.id, revision.id, 'NOT_INDEXED');
    }

    if (status.status === 'READY') {
      const space = options.embeddingSpaceId
        ? this.requireSpace(options.embeddingSpaceId)
        : this.embeddingService.ensureEmbeddingSpace();
      try {
        this.verifyReady(document.id, revision.id, space.id);
        let activated = document.currentRevisionId === revision.id;
        if (!activated && options.activate !== false) {
          this.storage.activateRevision(document.id, revision.id, [space.id]);
          activated = true;
        }
        return this.result(document.id, revision.id, space.id, true, activated);
      } catch {
        // READY is retained only when the requested embedding space is also
        // ready. A new/repair space re-enters the embedding stage explicitly.
        this.storage.setStatus(document.id, revision.id, 'EMBEDDING');
        status = this.storage.getStatus(document.id, revision.id)!;
      }
    }

    if (status.status === 'OCR_REQUIRED') {
      throw new Error(`Canonical revision requires OCR before indexing: ${revision.id}`);
    }

    if (status.status !== 'EMBEDDING') {
      this.advanceToLexicalReady(document.id, revision.id, status.status);
    }

    const workerId = options.workerId
      ?? `${DEFAULT_WORKER_PREFIX}-${randomUUID()}`;

    const ftsJob = this.storage.enqueueJob({
      documentId: document.id,
      revisionId: revision.id,
      jobType: 'rebuild_fts',
      maxAttempts: options.maxAttempts,
      metadata: { stage: 'canonical-fts' },
    });
    await this.runJob(ftsJob, workerId, async () => {
      const count = this.storage.rebuildFts(revision.id);
      const check = this.storage.checkFts(revision.id);
      if (check.actual !== check.expected || check.missing !== 0 || count !== check.expected) {
        throw new Error(`Canonical FTS readiness failed for revision ${revision.id}`);
      }
      this.storage.setStatus(document.id, revision.id, 'LEXICAL_READY', {
        chunkCount: check.expected,
      });
    });

    const space = options.embeddingSpaceId
      ? this.requireSpace(options.embeddingSpaceId)
      : this.embeddingService.ensureEmbeddingSpace();

    const embeddingJob = this.storage.enqueueJob({
      documentId: document.id,
      revisionId: revision.id,
      jobType: 'embed',
      embeddingSpaceId: space.id,
      maxAttempts: options.maxAttempts,
      metadata: { stage: 'canonical-embedding' },
    });

    let embeddingComplete = false;
    let embeddedChunkCount = 0;
    await this.runJob(embeddingJob, workerId, async () => {
      this.storage.setStatus(document.id, revision.id, 'EMBEDDING', {
        chunkCount: this.storage.readChunks(revision.id).length,
      });
      const embedding = await this.embeddingService.embedRevision(revision.id, {
        batchSize: options.batchSize,
        embeddingSpaceId: space.id,
      });
      embeddedChunkCount = embedding.embeddedCount;
      if (!embedding.complete) {
        throw new Error(
          `Canonical embedding incomplete for revision ${revision.id}: ${embedding.embeddedCount}/${embedding.chunkCount}`,
        );
      }
      embeddingComplete = true;
      this.storage.setStatus(document.id, revision.id, 'READY', {
        chunkCount: embedding.chunkCount,
        embeddedChunkCount: embedding.embeddedCount,
      });
    }, true);

    if (!embeddingComplete) {
      const current = this.storage.getStatus(document.id, revision.id)!;
      if (current.status === 'EMBEDDING') {
        const chunks = this.storage.readChunks(revision.id);
        const vectorReport = this.storage.checkVectorIndexForRevision(space.id, revision.id);
        const count = vectorReport.canonicalEmbeddings;
        if (count === chunks.length && vectorReport.missingVectorRows === 0) {
          this.storage.setStatus(document.id, revision.id, 'READY', {
            chunkCount: chunks.length,
            embeddedChunkCount: count,
          });
          embeddingComplete = true;
          embeddedChunkCount = count;
        }
      }
    }

    if (!embeddingComplete) {
      const current = this.storage.getStatus(document.id, revision.id)!;
      return {
        documentId: document.id,
        revisionId: revision.id,
        embeddingSpaceId: space.id,
        chunkCount: current.chunkCount,
        embeddedChunkCount: current.embeddedChunkCount,
        complete: false,
        activated: false,
      };
    }

    const vectorReport = this.storage.checkVectorIndexForRevision(space.id, revision.id);
    if (
      vectorReport.missingVectorRows > 0 ||
      vectorReport.dimensionMismatchRows > 0
    ) {
      const vectorJob = this.storage.enqueueJob({
        documentId: document.id,
        revisionId: revision.id,
        jobType: 'rebuild_vector_index',
        maxAttempts: options.maxAttempts,
        metadata: { stage: 'canonical-vector-repair', embeddingSpaceId: space.id },
      });
      await this.runJob(vectorJob, workerId, async () => {
        this.storage.rebuildVectorIndex(space.id);
        const repaired = this.storage.checkVectorIndexForRevision(space.id, revision.id);
        if (repaired.missingVectorRows > 0 || repaired.dimensionMismatchRows > 0) {
          throw new Error(`Canonical vector readiness failed for space ${space.id}`);
        }
      });
    }

    this.verifyReady(document.id, revision.id, space.id);

    let activated = false;
    if (options.activate !== false) {
      this.storage.activateRevision(document.id, revision.id, [space.id]);
      activated = true;
    }

    return this.result(document.id, revision.id, space.id, true, activated, embeddedChunkCount);
  }

  private advanceToLexicalReady(
    documentId: string,
    revisionId: string,
    status: CanonicalRagIndexStatus,
  ): void {
    let current = status;
    if (current === 'FAILED') {
      current = this.storage.setStatus(documentId, revisionId, 'QUEUED').status;
    }
    if (current === 'NOT_INDEXED') {
      current = this.storage.setStatus(documentId, revisionId, 'QUEUED').status;
    }
    if (current === 'QUEUED') {
      current = this.storage.setStatus(documentId, revisionId, 'EXTRACTING').status;
    }
    if (current === 'EXTRACTING') {
      current = this.storage.setStatus(documentId, revisionId, 'CHUNKING').status;
    }
    if (current === 'CHUNKING') {
      current = this.storage.setStatus(documentId, revisionId, 'LEXICAL_READY', {
        chunkCount: this.storage.readChunks(revisionId).length,
      }).status;
    }
    if (current !== 'LEXICAL_READY') {
      throw new Error(`Canonical revision cannot enter indexing from status ${current}`);
    }
  }

  private async runJob(
    job: CanonicalRagIndexJob,
    workerId: string,
    work: () => void | Promise<void>,
    returnFailure = false,
  ): Promise<void> {
    if (job.state === 'COMPLETED') return;
    if (job.state === 'FAILED' || job.state === 'CANCELLED') {
      if (returnFailure) return;
      throw new Error(`Canonical indexing job ${job.id} is ${job.state}`);
    }

    const claimed = this.storage.claimSpecificJob(job.id, {
      workerId,
      leaseMs: 120_000,
    });
    if (!claimed) {
      const current = this.storage.readJob(job.id);
      if (current?.state === 'COMPLETED') return;
      if (returnFailure && (current?.state === 'RETRY_WAIT' || current?.state === 'FAILED')) return;
      throw new Error(`Canonical indexing job ${job.id} could not be claimed`);
    }

    try {
      await work();
      this.storage.completeJob(job.id, workerId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.storage.failJob(job.id, message, true, workerId);
      if (returnFailure) {
        this.storage.setStatus(
          claimed.documentId,
          claimed.revisionId,
          'FAILED',
          { errorCode: 'INDEXING_FAILED', errorMessage: message },
        );
        return;
      }
      throw error;
    }
  }

  private verifyReady(documentId: string, revisionId: string, spaceId: string): void {
    const status = this.storage.getStatus(documentId, revisionId);
    if (!status || status.status !== 'READY') {
      throw new Error(`Canonical revision is not READY: ${revisionId}`);
    }
    const fts = this.storage.checkFts(revisionId);
    if (fts.actual !== fts.expected || fts.missing !== 0) {
      throw new Error(`Canonical FTS is not ready for revision ${revisionId}`);
    }
    const vector = this.storage.checkVectorIndexForRevision(spaceId, revisionId);
    if (vector.missingVectorRows > 0 || vector.dimensionMismatchRows > 0) {
      throw new Error(`Canonical vector index is not ready for space ${spaceId}`);
    }
  }

  private requireSpace(spaceId: string) {
    const space = this.storage.readEmbeddingSpace(spaceId);
    if (!space) throw new Error(`Canonical embedding space not found: ${spaceId}`);
    return space;
  }

  private result(
    documentId: string,
    revisionId: string,
    embeddingSpaceId: string,
    complete: boolean,
    activated: boolean,
    embeddedChunkCount?: number,
  ): CanonicalIndexRunResult {
    const status = this.storage.getStatus(documentId, revisionId)!;
    return {
      documentId,
      revisionId,
      embeddingSpaceId,
      chunkCount: status.chunkCount,
      embeddedChunkCount: embeddedChunkCount ?? status.embeddedChunkCount,
      complete,
      activated,
    };
  }
}
