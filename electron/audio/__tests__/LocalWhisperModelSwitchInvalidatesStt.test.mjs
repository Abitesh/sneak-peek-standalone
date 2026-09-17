// Regression: switching local transcript models (Settings → Audio, Split
// channels Distil vs Parakeet) left audio input dead because STT instances
// were reused with a constructor-baked modelId.
//
// setupSystemAudioPipeline only creates STT when `!this.googleSTT`. endMeeting
// used to stop those instances without nulling them, so the next Listen kept
// the old Parakeet worker after the UI already showed Distil.
//
// Guards:
//   1. An AppState helper (or equivalent) stop+removeAllListeners+nulls both
//      googleSTT and googleSTT_User so the recreate gate can fire.
//   2. Model-set IPC (or that helper) is what drops the instances.
//   3. setupSystemAudioPipeline's recreate gate stays `if (!this.googleSTT)`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const mainSource = fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8');
const ipcSource = fs.readFileSync(path.join(root, 'electron/ipcHandlers.ts'), 'utf8');

function extractMethodBody(src, methodName) {
  const re = new RegExp(
    `(?:public|private|protected)\\s+(?:async\\s+)?${methodName}\\s*\\([^)]*\\)\\s*(?::\\s*[^{;=]*(?:\\{[^{}]*\\}\\s*)?)?\\s*\\{`,
  );
  const m = re.exec(src);
  assert.ok(m, `could not locate ${methodName}`);
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  assert.equal(depth, 0, `unbalanced braces in ${methodName}`);
  return src.slice(start, i - 1);
}

test('invalidateSttInstances (or equivalent) nulls googleSTT and googleSTT_User', () => {
  const helperIdx = mainSource.search(/invalidateSttInstances\s*\(/);
  assert.ok(
    helperIdx >= 0,
    'BUG: AppState must expose invalidateSttInstances() so IPC can drop baked-in LocalWhisperSTT without poking private fields',
  );
  const body = extractMethodBody(mainSource, 'invalidateSttInstances');
  assert.match(
    body,
    /this\.googleSTT\s*=\s*null/,
    'BUG: invalidateSttInstances must null googleSTT so setupSystemAudioPipeline recreates interviewer STT',
  );
  assert.match(
    body,
    /this\.googleSTT_User\s*=\s*null/,
    'BUG: invalidateSttInstances must null googleSTT_User so setupSystemAudioPipeline recreates user STT',
  );
  assert.match(
    body,
    /googleSTT[\s\S]*removeAllListeners[\s\S]*googleSTT_User[\s\S]*removeAllListeners|googleSTT_User[\s\S]*removeAllListeners[\s\S]*googleSTT[\s\S]*removeAllListeners/,
    'BUG: invalidateSttInstances must stop+removeAllListeners on both STT instances (same teardown as _doReconfigureSttProvider)',
  );
});

test('model-set IPC calls invalidateSttInstances', () => {
  const setModelStart = ipcSource.indexOf("safeHandle('local-whisper-set-model'");
  assert.ok(setModelStart >= 0, 'local-whisper-set-model handler must exist');
  const setModelEnd = ipcSource.indexOf("safeHandle('local-whisper-reset-to-default'", setModelStart);
  const setModelBody = ipcSource.slice(setModelStart, setModelEnd > setModelStart ? setModelEnd : setModelStart + 1500);
  assert.match(
    setModelBody,
    /invalidateSttInstances\s*\(/,
    'BUG: local-whisper-set-model must call invalidateSttInstances after a successful write so idle Distil switches do not reuse a Parakeet LocalWhisperSTT',
  );
});

test('setupSystemAudioPipeline recreate gate stays if (!this.googleSTT)', () => {
  const body = extractMethodBody(mainSource, 'setupSystemAudioPipeline');
  assert.match(
    body,
    /if\s*\(\s*!this\.googleSTT\s*\)/,
    'BUG: setupSystemAudioPipeline must keep `if (!this.googleSTT)` as the interviewer STT recreate gate',
  );
  assert.match(
    body,
    /if\s*\(\s*!this\.googleSTT_User\s*\)/,
    'BUG: setupSystemAudioPipeline must keep `if (!this.googleSTT_User)` as the user STT recreate gate',
  );
});
