export type RagSourceType = 'meeting' | 'mode' | 'personal' | 'knowledge';

export interface RagDocument {
  id: string;
  sourceType: RagSourceType;
  name: string;
  path?: string;
  mimeType?: string;
  metadata: Record<string, unknown>;
}

export interface RagChunk {
  id: string;
  documentId: string;
  text: string;
  pageStart?: number;
  pageEnd?: number;
  section?: string;
  heading?: string;
  chunkIndex: number;
  startOffset?: number;
  endOffset?: number;
  speaker?: string;
  timestampStart?: number;
  timestampEnd?: number;
  metadata: Record<string, unknown>;
}

export interface RagSearchResult {
  chunk: RagChunk;
  score: number;
  semanticScore?: number;
  lexicalScore?: number;
  rerankScore?: number;
  source: RagDocument;
}

export interface StoredRagEmbedding {
  embedding: number[];
  space: string;
  provider?: string;
  dimensions?: number;
}