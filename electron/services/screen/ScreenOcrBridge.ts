// electron/services/screen/ScreenOcrBridge.ts
//
// Best-effort, independent OCR extraction run ALONGSIDE vision analysis
// (Problem 40 — dual path for accuracy). A vision model's transcription of a
// screenshot can paraphrase or misread dense text (a table, a stack trace, a
// code block); Tesseract gives back the literal characters as a second,
// independent source, merged into the same context text the vision model's
// summary already occupies.
//
// Deliberately NOT a replacement for ScreenUnderstandingService's vision-first
// design (see that file's header) — this is an ADDITIONAL call the vision
// path always races in parallel, so it never adds serial latency, and its
// failure/timeout must never block the vision answer.

import { getOcrProviderManager } from './OcrProviderManager';

export interface OcrBridgeResult {
  text: string;
  confidence?: number;
  provider?: string;
}

const EMPTY_RESULT: OcrBridgeResult = { text: '' };

/**
 * Never throws and never outlives `timeoutMs` — OcrProviderManager already
 * races each provider against `timeoutMs`, so this call itself cannot hang
 * the parallel vision request it accompanies.
 */
export async function extractOcrTextBestEffort(imagePath: string, timeoutMs = 8000): Promise<OcrBridgeResult> {
  if (!imagePath) return EMPTY_RESULT;
  try {
    const result = await getOcrProviderManager().recognize(imagePath, { timeoutMs });
    return { text: (result?.text || '').trim(), confidence: result?.confidence, provider: result?.provider };
  } catch (err: any) {
    console.warn('[ScreenOcrBridge] OCR extraction failed (non-fatal, vision path unaffected):', err?.message || err);
    return EMPTY_RESULT;
  }
}

/**
 * Merge vision-extracted text with independently-OCR'd text into one block.
 * Dedupes when one is a substring of the other (a slide screenshot's OCR
 * text often echoes the vision summary near-verbatim) so the prompt doesn't
 * carry the same paragraph twice.
 */
export function mergeScreenText(visionText: string | undefined | null, ocrText: string | undefined | null): string {
  const vision = (visionText || '').trim();
  const ocr = (ocrText || '').trim();
  if (!ocr) return vision;
  if (!vision) return ocr;
  const norm = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();
  if (norm(vision).includes(norm(ocr)) || norm(ocr).includes(norm(vision))) return vision;
  return `${vision}\n\n[OCR-extracted text]\n${ocr}`;
}
