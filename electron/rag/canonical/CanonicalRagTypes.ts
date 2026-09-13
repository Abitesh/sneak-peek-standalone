/**
 * Change 25 — Step 2.7
 * Canonical RAG storage domain types.
 *
 * This module has no production callers yet. It defines the physical storage
 * contract that will be used by later migration/dual-write work.
 */

export type CanonicalRagSourceType = 'meeting' | 'mode' | 'personal' | 'knowledge' | string;

export type CanonicalRagExtractionState =
  | 'PENDING'
  | 'EXTRACTED'
  | 'FAILED';

export type CanonicalRagIndexStatus =
  | 'NOT_INDEXED'
  | 'QUEUED'
  | 'EXTRACTING'
  | 'OCR_REQUIRED'
  | 'CHUNKING'
  | 'LEXICAL_READY'
  | 'EMBEDDING'
  | 'READY'
  | 'FAILED';

export type CanonicalRagJobType =
  | 'extract'
  | 'chunk'
  | 'rebuild_fts'
  | 'embed'
  | 'rebuild_vector_index';

export type CanonicalRagJobState =
  | 'QUEUED'
  | 'RUNNING'
  | 'RETRY_WAIT'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type CanonicalRagMetric = 'cosine';

export interface CanonicalRagDocument {
  id: string;
  sourceType: CanonicalRagSourceType;
  sourceId: string;
  ownerId: string | null;
  scopeId: string | null;
  name: string;
  path: string | null;
  mimeType: string | null;
  fileType: string | null;
  sizeBytes: number | null;
  contentHash: string | null;
  createdAt: string;
  updatedAt: string;
  currentRevisionId: string | null;
  deletedAt: string | null;
  metadata: Record<string, unknown>;
}

export interface CanonicalRagRevision {
  id: string;
  documentId: string;
  revisionNumber: number;
  contentHash: string;
  extractionVersion: string;
  chunkingVersion: string;
  normalizationVersion: string;
  extractionState: CanonicalRagExtractionState;
  createdAt: string;
  supersededAt: string | null;
  metadata: Record<string, unknown>;
}

export interface CanonicalRagChunk {
  id: string;
  documentId: string;
  revisionId: string;
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
  createdAt: string;
}

export interface CanonicalRagEmbeddingSpace {
  id: string;
  provider: string;
  model: string;
  dimensions: number;
  metric: CanonicalRagMetric;
  version: string;
  createdAt: string;
  retiredAt: string | null;
  vectorTableKey: number;
  metadata: Record<string, unknown>;
}

export interface CanonicalRagEmbedding {
  id: string;
  chunkId: string;
  embeddingSpaceId: string;
  physicalRowKey: number;
  vector: Float32Array;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface CanonicalRagIndexStatusRecord {
  documentId: string;
  revisionId: string;
  status: CanonicalRagIndexStatus;
  chunkCount: number;
  embeddedChunkCount: number;
  extractedPageCount: number | null;
  totalPageCount: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: number;
}

export interface CanonicalRagIndexJob {
  id: string;
  documentId: string;
  revisionId: string;
  jobType: CanonicalRagJobType;
  embeddingSpaceId: string | null;
  state: CanonicalRagJobState;
  attemptCount: number;
  maxAttempts: number;
  availableAt: number;
  leaseUntil: number | null;
  leasedBy: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  metadata: Record<string, unknown>;
}

export interface CreateDocumentInput {
  sourceType: CanonicalRagSourceType;
  sourceId: string;
  ownerId?: string | null;
  scopeId?: string | null;
  name: string;
  path?: string | null;
  mimeType?: string | null;
  fileType?: string | null;
  sizeBytes?: number | null;
  contentHash?: string | null;
  metadata?: Record<string, unknown>;
  id?: string;
}

export interface CreateRevisionInput {
  documentId: string;
  contentHash: string;
  extractionVersion: string;
  chunkingVersion: string;
  normalizationVersion: string;
  extractionState?: CanonicalRagExtractionState;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface CanonicalChunkInput {
  chunkIndex: number;
  text: string;
  pageStart?: number | null;
  pageEnd?: number | null;
  section?: string | null;
  heading?: string | null;
  contentType?: string | null;
  startChar?: number | null;
  endChar?: number | null;
  tableIndex?: number | null;
  tokenCount?: number | null;
  speaker?: string | null;
  timestampStart?: number | null;
  timestampEnd?: number | null;
  sourceLocator?: string | null;
  metadata?: Record<string, unknown>;
}

export interface EmbeddingSpaceInput {
  provider: string;
  model: string;
  dimensions: number;
  metric?: CanonicalRagMetric;
  version: string;
  metadata?: Record<string, unknown>;
  id?: string;
}

export interface IndexJobInput {
  documentId: string;
  revisionId: string;
  jobType: CanonicalRagJobType;
  embeddingSpaceId?: string | null;
  maxAttempts?: number;
  availableAt?: number;
  metadata?: Record<string, unknown>;
}

export interface ClaimJobOptions {
  workerId: string;
  now?: number;
  leaseMs?: number;
}

export interface VectorConsistencyReport {
  spaceId: string;
  vectorTableKey: number;
  canonicalEmbeddings: number;
  vectorRows: number;
  missingVectorRows: number;
  orphanVectorRows: number;
  dimensionMismatchRows: number;
}
