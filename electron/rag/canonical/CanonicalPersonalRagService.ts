/**
 * Change 25 — Step 2.9
 * Canonical projection for personal documents.
 *
 * Legacy personal storage remains the source being projected. This service
 * does not retrieve, rank, resolve providers, or modify legacy tables.
 */

import crypto from 'crypto';
import type { PersonalStorageAdapter } from '../storage/PersonalStorageAdapter';
import { CanonicalEmbeddingService } from './CanonicalEmbeddingService';
import type { CanonicalRagDocument, CanonicalRagRevision } from './CanonicalRagTypes';
import { CanonicalRagStorage } from './CanonicalRagStorage';
import { CanonicalRagIndexer } from './CanonicalRagIndexer';

export interface CanonicalPersonalProjectionResult {
  personalFileId: string;
  documentId: string;
  revisionId: string;
  embeddingSpaceId: string;
  chunkCount: number;
  embeddedChunkCount: number;
  complete: boolean;
  activated: boolean;
}

const EXTRACTION_VERSION = 'personal-document-extraction-v1';
const CHUNKING_VERSION = 'personal-document-map-v1';
const NORMALIZATION_VERSION = 'personal-normalization-v1';

export class CanonicalPersonalRagService {
  constructor(
    private readonly storage: CanonicalRagStorage,
    private readonly personalStorage: PersonalStorageAdapter,
    private readonly embeddingService: CanonicalEmbeddingService,
    private readonly indexer?: CanonicalRagIndexer,
  ) {}

  /**
   * Project the current legacy personal file representation into canonical
   * document/revision/chunk storage and embed it. Legacy rows are read only.
   */
  async projectPersonalFile(personalFileId: string): Promise<CanonicalPersonalProjectionResult> {
    const source = this.personalStorage.readDocument(personalFileId);
    if (!source) throw new Error(`Personal file not found: ${personalFileId}`);

    const chunks = this.personalStorage.readChunks(personalFileId);
    const contentHash = typeof source.metadata.contentHash === 'string'
      ? source.metadata.contentHash
      : this.computeChunkContentHash(chunks.map((chunk) => chunk.text));

    const document = this.storage.createDocument({
      sourceType: 'personal',
      sourceId: personalFileId,
      name: source.name,
      path: source.path ?? null,
      mimeType: source.mimeType ?? null,
      fileType: typeof source.metadata.fileType === 'string' ? source.metadata.fileType : null,
      sizeBytes: typeof source.metadata.sizeBytes === 'number' ? source.metadata.sizeBytes : null,
      contentHash,
      metadata: {
        migrationSource: 'personal_files',
        legacyDocumentId: personalFileId,
        ...(source.metadata ?? {}),
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
        migrationSource: 'personal_file_chunks',
        legacyDocumentId: personalFileId,
      },
    });

    const existingStatus = this.storage.getStatus(document.id, revision.id);
    if (!existingStatus || !['READY', 'EMBEDDING'].includes(existingStatus.status)) {
      this.storage.replaceChunks(document.id, revision.id, chunks.map((chunk) => ({
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      pageStart: chunk.pageStart ?? null,
      pageEnd: chunk.pageEnd ?? null,
      section: chunk.section ?? null,
      heading: chunk.heading ?? null,
      contentType: typeof chunk.metadata?.contentType === 'string' ? chunk.metadata.contentType : null,
      startChar: chunk.startOffset ?? null,
      endChar: chunk.endOffset ?? null,
      sourceLocator: `${chunk.chunkIndex}`,
      metadata: {
        migrationSource: 'personal_file_chunks',
        legacyChunkId: chunk.id,
        ...(chunk.metadata ?? {}),
      },
      })));
    }

    if (this.indexer) {
      const indexed = await this.indexer.indexRevision(revision.id, { activate: true });
      return {
        personalFileId,
        documentId: indexed.documentId,
        revisionId: indexed.revisionId,
        embeddingSpaceId: indexed.embeddingSpaceId,
        chunkCount: indexed.chunkCount,
        embeddedChunkCount: indexed.embeddedChunkCount,
        complete: indexed.complete,
        activated: indexed.activated,
      };
    }

    const embedding = await this.embeddingService.embedRevision(revision.id);
    const embeddedStatus = this.storage.setStatus(document.id, revision.id, 'EMBEDDING', {
      chunkCount: embedding.chunkCount,
      embeddedChunkCount: embedding.embeddedCount,
    });

    let activated = false;
    if (embedding.complete) {
      const ready = this.storage.setStatus(document.id, revision.id, 'READY', {
        chunkCount: embedding.chunkCount,
        embeddedChunkCount: embedding.embeddedCount,
      });
      void embeddedStatus;
      if (ready.status === 'READY') {
        this.storage.activateRevision(document.id, revision.id, [embedding.embeddingSpaceId]);
        activated = true;
      }
    }

    return {
      personalFileId,
      documentId: document.id,
      revisionId: revision.id,
      embeddingSpaceId: embedding.embeddingSpaceId,
      chunkCount: embedding.chunkCount,
      embeddedChunkCount: embedding.embeddedCount,
      complete: embedding.complete,
      activated,
    };
  }

  readCanonicalDocument(personalFileId: string): CanonicalRagDocument | null {
    return this.storage.readDocumentBySource('personal', personalFileId);
  }

  readCanonicalRevisions(personalFileId: string): CanonicalRagRevision[] {
    const document = this.readCanonicalDocument(personalFileId);
    return document ? this.storage.readRevisions(document.id) : [];
  }

  private computeChunkContentHash(texts: readonly string[]): string {
    return crypto.createHash('sha256').update(texts.join('\n'), 'utf8').digest('hex');
  }
}
