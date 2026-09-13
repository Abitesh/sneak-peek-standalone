/**
 * Change 25 — Step 2.9
 * Adapter from the existing EmbeddingPipeline to the source-independent
 * canonical embedding provider contract.
 *
 * This is an identity/translation boundary only. Provider selection, retry,
 * fallback, and network/model lifecycle remain owned by EmbeddingPipeline.
 */

import type { SourceIndependentEmbeddingProvider } from './CanonicalEmbeddingService';
import type { EmbeddingPipeline } from '../EmbeddingPipeline';

/** Compatibility version for the canonical adapter contract, not a model version. */
export const CANONICAL_EMBEDDING_PROVIDER_ADAPTER_VERSION = 'pipeline-v1';

export interface CanonicalPipelineEmbeddingIdentity {
  provider: string;
  model: string;
  dimensions: number;
  space: string;
  version: string;
}

export function getCanonicalPipelineEmbeddingIdentity(
  pipeline: EmbeddingPipeline,
): CanonicalPipelineEmbeddingIdentity | undefined {
  return pipeline.getActiveCanonicalEmbeddingIdentity();
}

/**
 * Captures one provider identity and refuses to label embeddings with another
 * space if EmbeddingPipeline promotes a fallback while this adapter is active.
 */
export class CanonicalEmbeddingProviderAdapter implements SourceIndependentEmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  readonly version: string;

  private readonly expectedSpace: string;

  constructor(private readonly pipeline: EmbeddingPipeline) {
    const identity = getCanonicalPipelineEmbeddingIdentity(pipeline);
    if (!identity) throw new Error('Embedding pipeline has no active provider');
    this.provider = identity.provider;
    this.model = identity.model;
    this.dimensions = identity.dimensions;
    this.version = identity.version;
    this.expectedSpace = identity.space;
  }

  async embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    const result = await this.pipeline.getEmbeddingsWithFallback([...texts]);
    if (result.space !== this.expectedSpace) {
      throw new Error(
        `Embedding provider space changed during canonical run: ${this.expectedSpace} -> ${result.space}`,
      );
    }
    if (result.provider && result.provider !== this.provider) {
      throw new Error(
        `Embedding provider changed during canonical run: ${this.provider} -> ${result.provider}`,
      );
    }
    if (result.dimensions && result.dimensions !== this.dimensions) {
      throw new Error(
        `Embedding dimensions changed during canonical run: ${this.dimensions} -> ${result.dimensions}`,
      );
    }
    return result.embeddings;
  }
}
