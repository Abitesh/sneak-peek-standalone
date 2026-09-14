// electron/rag/canonical/CanonicalRagShadowService.ts
// Change 25 Phase 6.3: observe-only lexical shadow for the canonical RAG store.
// This service never embeds, writes, reranks, gates, or mutates legacy results.

import { CanonicalRagStorage } from './CanonicalRagStorage';
import type { CanonicalRagLexicalSearchResult } from './CanonicalRagQueryTypes';

export type CanonicalRagShadowSourceType = 'meeting' | 'mode' | 'personal';

export interface CanonicalRagShadowOptions {
  sourceTypes?: readonly string[];
  limit?: number;
  legacyResultCount?: number;
}

export interface CanonicalRagShadowDiagnostic {
  enabled: true;
  succeeded: boolean;
  sourceTypes: CanonicalRagShadowSourceType[];
  legacyResultCount: number;
  canonicalResultCount: number;
  durationMs: number;
  errorCategory?: 'storage' | 'query';
}

const MAX_DIAGNOSTICS = 100;
const diagnostics: CanonicalRagShadowDiagnostic[] = [];

function nowMs(): number {
  try { return Number(process.hrtime.bigint()) / 1e6; } catch { return Date.now(); }
}

function normalizeSourceTypes(sourceTypes?: readonly string[]): CanonicalRagShadowSourceType[] {
  const selected = new Set<CanonicalRagShadowSourceType>();
  for (const source of sourceTypes ?? ['meeting', 'mode-reference', 'personal-files']) {
    if (source === 'meeting') selected.add('meeting');
    else if (source === 'mode-reference') selected.add('mode');
    else if (source === 'personal-files') selected.add('personal');
  }
  return [...selected];
}

function recordDiagnostic(diagnostic: CanonicalRagShadowDiagnostic): void {
  diagnostics.push(diagnostic);
  if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.shift();
}

export class CanonicalRagShadowService {
  constructor(private readonly storage: CanonicalRagStorage) {}

  async observe(query: string, options: CanonicalRagShadowOptions = {}): Promise<CanonicalRagShadowDiagnostic> {
    const startedAt = nowMs();
    const sourceTypes = normalizeSourceTypes(options.sourceTypes);
    const limit = Math.max(1, Math.min(50, options.limit ?? 20));
    let canonicalResultCount = 0;

    try {
      const normalizedQuery = String(query ?? '').trim();
      if (!normalizedQuery || sourceTypes.length === 0) {
        const diagnostic: CanonicalRagShadowDiagnostic = {
          enabled: true,
          succeeded: true,
          sourceTypes,
          legacyResultCount: options.legacyResultCount ?? 0,
          canonicalResultCount: 0,
          durationMs: Math.max(0, nowMs() - startedAt),
        };
        recordDiagnostic(diagnostic);
        return diagnostic;
      }

      for (const sourceType of sourceTypes) {
        const results: CanonicalRagLexicalSearchResult[] = this.storage.searchLexical(normalizedQuery, {
          sourceType,
          limit,
        });
        canonicalResultCount += results.length;
      }

      const diagnostic: CanonicalRagShadowDiagnostic = {
        enabled: true,
        succeeded: true,
        sourceTypes,
        legacyResultCount: options.legacyResultCount ?? 0,
        canonicalResultCount,
        durationMs: Math.max(0, nowMs() - startedAt),
      };
      recordDiagnostic(diagnostic);
      return diagnostic;
    } catch (error) {
      const diagnostic: CanonicalRagShadowDiagnostic = {
        enabled: true,
        succeeded: false,
        sourceTypes,
        legacyResultCount: options.legacyResultCount ?? 0,
        canonicalResultCount,
        durationMs: Math.max(0, nowMs() - startedAt),
        errorCategory: error instanceof Error ? 'query' : 'storage',
      };
      recordDiagnostic(diagnostic);
      return diagnostic;
    }
  }

  static recentDiagnostics(limit = 20): CanonicalRagShadowDiagnostic[] {
    const count = Math.max(0, Math.min(MAX_DIAGNOSTICS, Math.floor(limit)));
    return diagnostics.slice(Math.max(0, diagnostics.length - count));
  }

  static resetDiagnostics(): void {
    diagnostics.length = 0;
  }
}
