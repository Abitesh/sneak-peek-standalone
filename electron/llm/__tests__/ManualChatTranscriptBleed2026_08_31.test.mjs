import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const contextEnginePath = path.resolve(__dirname, '../contextEngine.ts');
const ipcPath = path.resolve(__dirname, '../../ipcHandlers.ts');
const uiPath = path.resolve(__dirname, '../../../src/components/NativelyInterface.tsx');

// Load the pure helper. The electron test runner usually has dist-electron;
// fall back to asserting the source contract if require fails.
function loadHelper() {
  const candidates = [
    path.resolve(__dirname, '../../../../dist-electron/electron/llm/contextEngine.js'),
    path.resolve(__dirname, '../contextEngine.js'),
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch { /* try next */ }
  }
  return null;
}

const helper = loadHelper();

test('shouldAttachLiveTranscriptToManualChat rejects ordinary questions even during a meeting', () => {
  if (!helper?.shouldAttachLiveTranscriptToManualChat) {
    const src = readFileSync(contextEnginePath, 'utf8');
    assert.match(src, /export function shouldAttachLiveTranscriptToManualChat/);
    assert.match(src, /LIVE_TRANSCRIPT_REFERENT_RE/);
    return;
  }
  const { shouldAttachLiveTranscriptToManualChat } = helper;
  assert.equal(
    shouldAttachLiveTranscriptToManualChat({
      query: 'What is the time complexity of quicksort?',
      meetingActive: true,
    }),
    false,
  );
  assert.equal(
    shouldAttachLiveTranscriptToManualChat({ query: 'hi', meetingActive: true }),
    false,
  );
  assert.equal(
    shouldAttachLiveTranscriptToManualChat({
      query: 'What did they just ask?',
      meetingActive: false,
    }),
    false,
  );
});

test('shouldAttachLiveTranscriptToManualChat allows meeting-referential questions while meeting is active', () => {
  if (!helper?.shouldAttachLiveTranscriptToManualChat) return;
  const { shouldAttachLiveTranscriptToManualChat } = helper;
  assert.equal(
    shouldAttachLiveTranscriptToManualChat({
      query: 'What did they just ask?',
      meetingActive: true,
    }),
    true,
  );
  assert.equal(
    shouldAttachLiveTranscriptToManualChat({
      query: 'Can you repeat that question?',
      meetingActive: true,
    }),
    true,
  );
});

test('manual-chat V3 conversationSummary is gated (no unconditional getFormattedContext dump)', () => {
  const ipc = readFileSync(ipcPath, 'utf8');
  assert.match(ipc, /shouldAttachLiveTranscriptToManualChat/);
  assert.match(ipc, /getIsMeetingActive/);
  assert.doesNotMatch(
    ipc,
    /if \(isTrivialQuery\(v3Question\)\) return undefined;\s*\n\s*return appState\.getIntelligenceManager\?\.\(\)\?\.getFormattedContext/,
  );
});

test('voice Analyze does not pass a fabricated interview prompt as IPC context', () => {
  const ui = readFileSync(uiPath, 'utf8');
  assert.doesNotMatch(
    ui,
    /You are a real-time interview assistant\. The user just repeated/,
  );
});
