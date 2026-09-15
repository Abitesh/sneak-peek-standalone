/**
 * Change 25 — Step 2.8
 * Source-independent canonical embedding service.
 *
 * This layer deliberately knows nothing about meetings, mode files, personal
 * files, or any other source family. It accepts canonical revision/chunk
 * identity plus a generic embedding provider and persists vectors through
 * CanonicalRagStorage.
 *
 * Production callers reach it through RAGManager (canonical-primary index and
 * backfill). Provider selection stays in EmbeddingProviderResolver.
 */

import type { CanonicalRagEmbeddingSpace } from './CanonicalRagTypes';
import { CanonicalRagStorage } from './CanonicalRagStorage';
import { embeddingSpaceKey } from '../embeddingSpace';

export interface SourceIndependentEmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  readonly version: string;
  embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface CanonicalEmbeddingRunOptions {
  batchSize?: number;
  embeddingSpaceId?: string;
}

export interface CanonicalEmbeddingRunResult {
  documentId: string;
  revisionId: string;
  embeddingSpaceId: string;
  chunkCount: number;
  embeddedCount: number;
  complete: boolean;
}

const DEFAULT_BATCH_SIZE = 32;
const MAX_BATCH_SIZE = 64;

function normalizeBatchSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_BATCH_SIZE;
  if (!Number.isFinite(value)) throw new Error('Embedding batch size must be finite');
  const batchSize = Math.floor(value);
  if (batchSize <= 0) throw new Error('Embedding batch size must be greater than zero');
  return Math.min(MAX_BATCH_SIZE, batchSize);
}

/**
 * Embeds canonical chunks without consulting or mutating any source-specific
 * storage. The provider identity is bound to one canonical embedding space.
 */
export class CanonicalEmbeddingService {
  constructor(
    private readonly storage: CanonicalRagStorage,
    private readonly provider: SourceIndependentEmbeddingProvider,
  ) {}

  /**
   * Resolve the canonical embedding space for the provider. A space is reusable
   * across documents and revisions, so this operation is idempotent.
   */
  ensureEmbeddingSpace(): CanonicalRagEmbeddingSpace {
    if (!this.provider.provider.trim()) throw new Error('Embedding provider name cannot be empty');
    if (!this.provider.model.trim()) throw new Error('Embedding model cannot be empty');
    if (!this.provider.version.trim()) throw new Error('Embedding provider version cannot be empty');
    if (!Number.isInteger(this.provider.dimensions) || this.provider.dimensions <= 0) {
      throw new Error('Embedding provider dimensions must be a positive integer');
    }

    return this.storage.createEmbeddingSpace({
      id: `${embeddingSpaceKey({
        name: this.provider.provider,
        model: this.provider.model,
        dimensions: this.provider.dimensions,
      })}:${this.provider.version}`,
      provider: this.provider.provider,
      model: this.provider.model,
      dimensions: this.provider.dimensions,
      metric: 'cosine',
      version: this.provider.version,
    });
  }

  /**
   * Embed every chunk in one canonical revision. Existing vectors in the same
   * space are safely replaced, so retries are idempotent at the chunk/space
   * boundary. A provider failure leaves successfully persisted earlier batches
   * intact and returns complete=false.
   */
  async embedRevision(
    revisionId: string,
    options: CanonicalEmbeddingRunOptions = {},
  ): Promise<CanonicalEmbeddingRunResult> {
    const revision = this.storage.readRevision(revisionId);
    if (!revision) throw new Error(`Canonical revision not found: ${revisionId}`);

    const document = this.storage.readDocument(revision.documentId);
    if (!document) throw new Error(`Canonical document not found: ${revision.documentId}`);
    if (document.deletedAt) throw new Error('Cannot embed a deleted document');

    const chunks = this.storage.readChunks(revisionId);
    const space = options.embeddingSpaceId
      ? this.requireCompatibleSpace(options.embeddingSpaceId)
      : this.ensureEmbeddingSpace();
    const batchSize = normalizeBatchSize(options.batchSize);

    if (chunks.length === 0) {
      return {
        documentId: document.id,
        revisionId,
        embeddingSpaceId: space.id,
        chunkCount: 0,
        embeddedCount: 0,
        complete: true,
      };
    }

    let embeddedCount = 0;
    for (let start = 0; start < chunks.length; start += batchSize) {
      const batch = chunks.slice(start, start + batchSize);
      let vectors: readonly (readonly number[])[];
      try {
        vectors = await this.provider.embedBatch(batch.map((chunk) => chunk.text));
      } catch (error) {
        return {
          documentId: document.id,
          revisionId,
          embeddingSpaceId: space.id,
          chunkCount: chunks.length,
          embeddedCount,
          complete: false,
        };
      }

      if (!Array.isArray(vectors) || vectors.length !== batch.length) {
        return {
          documentId: document.id,
          revisionId,
          embeddingSpaceId: space.id,
          chunkCount: chunks.length,
          embeddedCount,
          complete: false,
        };
      }

      try {
        for (let i = 0; i < batch.length; i += 1) {
          const vector = vectors[i];
          if (!Array.isArray(vector) && !(vector instanceof Float32Array)) {
            throw new Error(`Embedding provider returned an invalid vector for chunk ${batch[i].id}`);
          }
          const normalizedVector = vector instanceof Float32Array ? Array.from(vector) : vector;
          this.storage.storeEmbedding(batch[i].id, space.id, normalizedVector);
          embeddedCount += 1;
        }
      } catch (error) {
        return {
          documentId: document.id,
          revisionId,
          embeddingSpaceId: space.id,
          chunkCount: chunks.length,
          embeddedCount,
          complete: false,
        };
      }
    }

    return {
      documentId: document.id,
      revisionId,
      embeddingSpaceId: space.id,
      chunkCount: chunks.length,
      embeddedCount,
      complete: embeddedCount === chunks.length,
    };
  }

  private requireCompatibleSpace(spaceId: string): CanonicalRagEmbeddingSpace {
    const space = this.storage.readEmbeddingSpace(spaceId);
    if (!space) throw new Error(`Canonical embedding space not found: ${spaceId}`);

    if (
      space.provider !== this.provider.provider ||
      space.model !== this.provider.model ||
      space.dimensions !== this.provider.dimensions ||
      space.metric !== 'cosine' ||
      space.version !== this.provider.version
    ) {
      throw new Error('Embedding provider does not match the requested canonical embedding space');
    }

    return space;
  }
}
