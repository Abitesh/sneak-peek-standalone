// Retrieval adapter for the persistent My Files store.
// The store is intentionally separate from mode attachments, but it must enter
// the same authorized EvidenceItem pipeline before provider dispatch.

import type { EvidenceScope, SourceType } from '../contracts/types';
import type { RetrievalPort } from '../orchestration/orchestrator';
import type { LegacyChunk } from './legacy-adapter';
import { createLegacyRetrievalPort } from './legacy-retrieval-port';

export interface PersonalFileSearchLike {
  listFiles(): Array<{ id: string; fileName?: string }>;
  search(query: string, limit?: number): Array<{
    fileId: string;
    fileName?: string;
    chunkId: string;
    text: string;
    score?: number;
    startChar?: number;
    endChar?: number;
  }>;
}

export function createPersonalFileRetrievalPort(
  manager: PersonalFileSearchLike,
  scope: EvidenceScope,
  options: { topK?: number; timeoutMs?: number } = {},
): RetrievalPort {
  const sourceTypes = new Map<string, SourceType>();
  const activeVersions = new Map<string, string>();
  const sourceScopes = new Map<string, EvidenceScope>();

  for (const file of manager.listFiles()) {
    sourceTypes.set(file.id, 'REFERENCE_FILE');
    activeVersions.set(file.id, 'current');
    sourceScopes.set(file.id, scope);
  }

  return createLegacyRetrievalPort({
    retrieve: async (query): Promise<LegacyChunk[]> => manager.search(query, options.topK ?? 20).map((item) => ({
      sourceId: item.fileId,
      fileName: item.fileName,
      text: item.text,
      chunkIndex: 0,
      score: item.score,
      metadata: { chunkId: item.chunkId, startChar: item.startChar, endChar: item.endChar },
    })),
    registry: { sourceTypes, activeVersions, sourceScopes },
    assumeCurrentWhenVersionUnknown: true,
    assumeInScopeWhenUnknown: true,
    now: () => Date.now(),
  });
}
