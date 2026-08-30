// electron/personalKnowledge/__tests__/SprintS6ContextManagerWiring2026_08_31.test.mjs
//
// Sprint S6 — File RAG + Context Manager (Problems 13-14, 29-34, 46).
// Source-inspection regressions for the wiring points that don't reduce to a
// pure-function unit test: a renderer call site no longer opting out of
// retrieval, and the IPC/retry plumbing that backs tagging + re-indexing.
//
// Run: node --test on this file directly (reads source, no build required).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');

const NATIVELY_INTERFACE = read('../../../src/components/NativelyInterface.tsx');
const PERSON1_IPC = read('../person1Ipc.ts');
const PERSONAL_KNOWLEDGE_MANAGER = read('../PersonalKnowledgeManager.ts');
const MAIN_TS = read('../../main.ts');
const PRELOAD = read('../../preload.ts');
const MY_FILES_PANEL = read('../../../src/components/settings/MyFilesPanel.tsx');

describe('Problem 29-30: voice Analyze answers route through V3 like typed chat', () => {
  test('the voice-answer streamGeminiChat call no longer opts out of the system prompt/V3', () => {
    // Not anchored to a specific function name: this call site was
    // `handleAnswerNow` when this fix was written and has since been split
    // into `handleAnalyzeNow` by the Listen/Analyze UX work (Problem 47) —
    // the invariant that matters is the flag is gone from the file, not
    // which function currently owns the call.
    assert.doesNotMatch(
      NATIVELY_INTERFACE,
      /skipSystemPrompt:\s*true/,
      'no call site in NativelyInterface.tsx may opt a chat turn out of Context Intelligence V3 — that was the "voice bypasses RAG" defect',
    );
    assert.match(
      NATIVELY_INTERFACE,
      /streamGeminiChat\(\s*question,/,
      'the voice-answer path must still call streamGeminiChat with the spoken question',
    );
  });
});

describe('Problem 33-34: résumé/JD tagging exists end-to-end', () => {
  test('PersonalKnowledgeManager exposes fileType tagging + a boost for tagged files', () => {
    assert.match(PERSONAL_KNOWLEDGE_MANAGER, /export type PersonalFileType = 'resume' \| 'job_description' \| 'general'/);
    assert.match(PERSONAL_KNOWLEDGE_MANAGER, /setFileType\(id: string, fileType: string\)/);
    assert.match(PERSONAL_KNOWLEDGE_MANAGER, /TAGGED_FILE_BOOST/);
  });

  test('the set-file-type IPC handler is registered', () => {
    assert.match(PERSON1_IPC, /safeHandle\('personal-files:set-file-type'/);
  });

  test('preload exposes personalFilesSetFileType to the renderer', () => {
    assert.match(PRELOAD, /personalFilesSetFileType:/);
  });

  test('the Context Manager UI lets a user tag a file and shows a real index status', () => {
    assert.match(MY_FILES_PANEL, /personalFilesSetFileType/);
    assert.match(MY_FILES_PANEL, /STATUS_BADGES/);
    assert.doesNotMatch(
      MY_FILES_PANEL,
      />READY<\/span>/,
      'the status badge must be derived from indexStatus, not hardcoded',
    );
  });
});

describe('Problem 46: re-index retries on the same embedder-ready lifecycle as mode files', () => {
  test('scheduleModeReferenceIndexRetry also repairs personal-knowledge files', () => {
    const start = MAIN_TS.indexOf('public scheduleModeReferenceIndexRetry(): void {');
    assert.ok(start >= 0, 'scheduleModeReferenceIndexRetry must exist');
    const body = MAIN_TS.slice(start, start + 1200);
    assert.match(
      body,
      /getPersonalKnowledgeManager/,
      'the shared retry entrypoint (boot, Ollama pull, key save) must also retry personal-file extraction repair',
    );
    assert.match(body, /repairUnreadableIndexes/);
  });

  test('repairUnreadableIndexes is public so main.ts can call it', () => {
    assert.doesNotMatch(
      PERSONAL_KNOWLEDGE_MANAGER,
      /private async repairUnreadableIndexes/,
      'repairUnreadableIndexes must be callable from AppState.scheduleModeReferenceIndexRetry',
    );
    assert.match(PERSONAL_KNOWLEDGE_MANAGER, /async repairUnreadableIndexes\(\): Promise<\{ repaired: number; errors: number \}>/);
  });
});
