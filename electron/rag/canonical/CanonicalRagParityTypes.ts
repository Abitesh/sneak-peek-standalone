/**
 * Change 25 — Phase 4
 * Read-only legacy ↔ canonical RAG parity types.
 */

export type ParitySourceType = 'mode' | 'personal' | 'meeting';
export type ParityStatus = 'PASS' | 'FAIL' | 'PARTIAL' | 'NOT_COMPARABLE';
export type ParityComparisonType =
  | 'EXACT'
  | 'SEMANTIC'
  | 'DERIVED'
  | 'MISSING'
  | 'EXTRA'
  | 'DIFFERENT_SPACE'
  | 'NOT_COMPARABLE'
  | 'STALE_SOURCE'
  | 'INTENTIONAL_EXCLUSION';

export type ParitySeverity = 'info' | 'warning' | 'error';

export interface ParityDiscrepancy {
  sourceType: ParitySourceType;
  sourceId: string;
  legacyDocumentId?: string | null;
  legacyChunkId?: string | null;
  canonicalDocumentId?: string | null;
  canonicalRevisionId?: string | null;
  canonicalChunkId?: string | null;
  field: string;
  expectedValue?: unknown;
  actualValue?: unknown;
  comparisonType: ParityComparisonType;
  severity: ParitySeverity;
  reason: string;
  intentional: boolean;
  verifiable: boolean;
}

export interface ParityResult {
  sourceType: ParitySourceType;
  sourceId: string;
  status: ParityStatus;
  checkedFields: number;
  discrepancies: ParityDiscrepancy[];
}

export interface ParityAggregateResult {
  status: ParityStatus;
  attempted: number;
  passed: number;
  failed: number;
  partial: number;
  notComparable: number;
  results: ParityResult[];
}
