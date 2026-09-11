// Shared production reference-file ingestion for Modes Manager uploads.
//
// The dialog IPC and the gated E2E benchmark ingress both call this use case so
// benchmark parsing/persistence cannot silently drift from the user-facing path.
//
// Senior-review fix (2026-07-16, audit ab9dc2f0): this module previously
// duplicated the SAFE_DOCUMENT_EXTENSIONS format list, BOM/symlink safety,
// PDF worker pin, and PDF/DOCX/text parsing. Migrated to the shared
// SafeDocumentTextExtractor.extractSafeDocumentText so a format/safety
// fix in the shared utility automatically applies here AND to the
// Profile Intelligence upload path (premium/electron/knowledge/
// DocumentReader.ts which has used it since commit 41edd51). The
// MODE_REFERENCE_FILE_EXTENSIONS / MODE_REFERENCE_FILE_MAX_BYTES exports
// remain ON the file (re-exported from the shared utility) so callers
// that imported them from this module keep working.

import * as crypto from 'crypto';
import { ModesManager } from './ModesManager';
import type { ModeReferenceFile } from './ModesManager';
import type { RAGManager } from '../rag/RAGManager';
import {
  extractSafeDocumentText,
  SAFE_DOCUMENT_EXTENSIONS,
  SAFE_DOCUMENT_MAX_BYTES,
} from './SafeDocumentTextExtractor';

// Retain the Modes-facing exports while sharing one document-format contract.
export const MODE_REFERENCE_FILE_EXTENSIONS = SAFE_DOCUMENT_EXTENSIONS;
export const MODE_REFERENCE_FILE_MAX_BYTES = SAFE_DOCUMENT_MAX_BYTES;

export interface ModeReferenceFileIngestResult {
  id: string;
  fileName: string;
  /**
   * Extracted text content. Bug fix (2026-07-26): this was previously
   * omitted from the returned result, even though it was fully available
   * (`extracted.content`) — the renderer pushes this result straight into
   * its `referenceFiles` list (ModesSettings.tsx's `uploadFile`) and then
   * renders `file.content.length` unconditionally, so every successful
   * upload crashed the Modes settings panel until the next full reload
   * (which re-fetches via `modes:get-reference-files`, whose `rowToFile`
   * mapping always included `content`).
   */
  content: string;
  pageCount?: number;
  extractedPageCount?: number;
  binarySha256: string;
  contentSha256: string;
}

export interface ModeReferenceFileIngestOptions {
  modeId: string;
  filePath: string;
  onIndexStatus?: (status: import('../rag/RAGManager').RagIndexStatus, fileId: string, snapshot?: any) => void;
  ragManager?: RAGManager;
}

/**
 * Parse, persist, and begin indexing a user-selected regular file. Callers must
 * perform UI/authorization policy; this use case delegates file safety, format
 * checks, and PDF/DOCX/text parsing to the shared SafeDocumentTextExtractor.
 */
export const ingestModeReferenceFile = async (
  options: ModeReferenceFileIngestOptions,
): Promise<ModeReferenceFileIngestResult> => {
  const fileId = `ref_${crypto.randomUUID()}`;
  // The file row does not exist until extraction succeeds, so do not persist
  // canonical status rows for this pre-persistence phase. Emit transient
  // lifecycle notifications to the current renderer instead; once the file is
  // durable, RAGManager owns the persisted canonical lifecycle.
  const emitTransient = (status: import('../rag/RAGManager').RagIndexStatus) => {
    options.onIndexStatus?.(status, fileId, {
      sourceType: 'mode', documentId: fileId, status, chunkCount: 0,
      embeddedChunkCount: 0, updatedAt: Date.now(),
    });
  };
  emitTransient('QUEUED');
  emitTransient('EXTRACTING');
  let extracted: Awaited<ReturnType<typeof extractSafeDocumentText>>;
  try {
    extracted = await extractSafeDocumentText(options.filePath);
  } catch (error) {
    // The document was never persisted, so FAILED is also transient. Never
    // create a durable canonical row for a nonexistent mode file.
    emitTransient('FAILED');
    throw error;
  }
  const contentSha256 = crypto.createHash('sha256').update(extracted.content).digest('hex');
  const manager = ModesManager.getInstance();
  let file: ModeReferenceFile;
  try {
    file = manager.addReferenceFile({
      id: fileId,
      modeId: options.modeId,
      fileName: extracted.fileName,
      content: extracted.content,
      pageCount: extracted.pageCount,
      extractedPageCount: extracted.extractedPageCount,
    });
  } catch (error) {
    throw error;
  }

  // The file now exists durably; canonical persistence starts only after this
  // point, so every persisted status is tied to a real document row.
  options.ragManager?.setIndexStatus('mode', fileId, 'QUEUED', {}, (snapshot) => {
    options.onIndexStatus?.(snapshot.status, fileId, snapshot);
  });
  void (async () => {
    try {
      if (options.ragManager?.indexDocument) {
        await options.ragManager.indexDocument({
          sourceType: 'mode',
          documentId: file.id,
          content: file.content,
          fileName: file.fileName,
          pageCount: file.pageCount,
          extractedPageCount: file.extractedPageCount,
          metadata: { modeId: file.modeId },
          onStatus: (snapshot) => options.onIndexStatus?.(snapshot.status, file.id, snapshot),
        });
      } else {
        // Compatibility path for direct/unit callers that do not have the
        // application-owned RAGManager. Production IPC always supplies it.
        await manager.indexReferenceFile(file);
        const legacy = manager.getReferenceFileIndexStatus(file.id);
        const canonical = legacy.status === 'ready' ? 'READY'
          : legacy.status === 'ocr_required' ? 'OCR_REQUIRED'
          : legacy.status === 'failed' || legacy.status === 'lexical_only' ? 'FAILED'
          : 'EMBEDDING';
        options.onIndexStatus?.(canonical as import('../rag/RAGManager').RagIndexStatus, file.id);
      }
      const finalStatus = manager.getReferenceFileIndexStatus(file.id);
      if (finalStatus?.status === 'failed' || finalStatus?.status === 'lexical_only') {
        // The caller's application lifecycle owns retries; this preserves the
        // normal upload's non-blocking response behavior.
      }
    } catch (error: any) {
      console.warn('[ModeReferenceFileIngestion] index failed (lexical fallback remains):', error?.message);
    } finally {
      // Terminal status is already emitted by RAGManager. Compatibility callers
      // that do not provide a RAGManager still receive no synthetic READY.
    }
  })();

  return {
    id: file.id,
    fileName: extracted.fileName,
    content: extracted.content,
    pageCount: extracted.pageCount,
    extractedPageCount: extracted.extractedPageCount,
    binarySha256: extracted.binarySha256,
    contentSha256,
  };
};