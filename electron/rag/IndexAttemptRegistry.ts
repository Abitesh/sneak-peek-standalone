// Shared per-document indexing attempt ownership.
// A document can be re-indexed or deleted while an earlier embedding run is
// still awaiting async work. The newest lifecycle operation owns the document;
// older operations must stop before mutating chunks, vectors, or terminal state.

type AttemptKey = string;

const getRegistry = (): Map<AttemptKey, number> => {
  const g = globalThis as unknown as { __nativelyRagIndexAttemptsV1__?: Map<AttemptKey, number> };
  return g.__nativelyRagIndexAttemptsV1__ ?? (g.__nativelyRagIndexAttemptsV1__ = new Map());
};

const keyFor = (sourceType: string, documentId: string): AttemptKey => `${sourceType}:${documentId}`;

export const beginIndexAttempt = (sourceType: string, documentId: string): number => {
  const registry = getRegistry();
  const key = keyFor(sourceType, documentId);
  const next = (registry.get(key) ?? 0) + 1;
  registry.set(key, next);
  return next;
};

export const isCurrentIndexAttempt = (sourceType: string, documentId: string, attempt: number): boolean => {
  return getRegistry().get(keyFor(sourceType, documentId)) === attempt;
};

/** Invalidate all work currently associated with this document. */
export const invalidateIndexAttempt = (sourceType: string, documentId: string): number => {
  const registry = getRegistry();
  const key = keyFor(sourceType, documentId);
  const next = (registry.get(key) ?? 0) + 1;
  registry.set(key, next);
  return next;
};

/**
 * Execute one synchronous mutation only while the supplied attempt still owns
 * the document. The check and callback run in the same JavaScript turn, so a
 * newer attempt/deletion cannot interleave between the ownership check and the
 * synchronous vector-store write.
 */
export const withCurrentIndexAttempt = <T>(
  sourceType: string,
  documentId: string,
  attempt: number,
  mutation: () => T,
): T | null => {
  if (!isCurrentIndexAttempt(sourceType, documentId, attempt)) return null;
  return mutation();
};
