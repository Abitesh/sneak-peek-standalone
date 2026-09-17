// Regression: Settings → Audio always starts startAudioTest (mic + system
// meters). start-meeting used to construct a second MicrophoneCapture on the
// same device without stopping the test first. On Windows WASAPI exclusive
// mode the second open fails; on both platforms one of the two captures dies.
//
// Invariant: meeting audio init (startMeetingTransition, and any Listen path
// that opens meeting captures) calls stopAudioTest BEFORE constructing a
// meeting MicrophoneCapture / running setupSystemAudioPipeline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const mainSource = fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8');

function sliceUntilNextMethod(startMarker, nextMarker) {
  const start = mainSource.indexOf(startMarker);
  assert.ok(start >= 0, `could not locate ${startMarker}`);
  const end = mainSource.indexOf(nextMarker, start + startMarker.length);
  assert.ok(end >= 0, `could not locate ${nextMarker} after ${startMarker}`);
  return mainSource.slice(start, end);
}

function extractMethodBody(methodName) {
  const re = new RegExp(
    `(?:public|private|protected)\\s+(?:async\\s+)?${methodName}\\s*\\([^)]*\\)\\s*(?::\\s*[^{;=]*(?:\\{[^{}]*\\}\\s*)?)?\\s*\\{`,
  );
  const m = re.exec(mainSource);
  assert.ok(m, `could not locate ${methodName} in main.ts`);
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  while (i < mainSource.length && depth > 0) {
    const ch = mainSource[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  assert.equal(depth, 0, `unbalanced braces in ${methodName}`);
  return mainSource.slice(start, i - 1);
}

function scrubNonCode(body) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/`(?:\\.|[^`])*`/g, '``')
    .replace(/'(?:\\.|[^'])*'/g, "''")
    .replace(/"(?:\\.|[^"])*"/g, '""');
}

test('startMeetingTransition calls stopAudioTest before constructing meeting MicrophoneCapture', () => {
  const body = scrubNonCode(extractMethodBody('startMeetingTransition'));
  const stopIdx = body.search(/this\.stopAudioTest\s*\(/);
  assert.ok(
    stopIdx >= 0,
    'BUG: startMeetingTransition must call this.stopAudioTest() so Settings audio-test meters release WASAPI/CoreAudio before meeting capture opens',
  );
  const pipelineIdx = body.search(/this\.(?:reconfigureAudio|setupSystemAudioPipeline)\s*\(/);
  assert.ok(pipelineIdx >= 0, 'sanity: startMeetingTransition still builds the audio pipeline');
  assert.ok(
    stopIdx < pipelineIdx,
    `BUG: stopAudioTest must run before reconfigureAudio / setupSystemAudioPipeline (stopIdx=${stopIdx}, pipelineIdx=${pipelineIdx}). Two MicrophoneCapture instances on one exclusive device leave meeting input dead.`,
  );
});

test('ensureListenAudioCapture calls stopAudioTest before setupSystemAudioPipeline', () => {
  // Return type is Promise<{ ... }> — brace-scanning extractMethodBody would
  // treat the type literal as the body (same helper as ListenAudioInitContract).
  const body = scrubNonCode(sliceUntilNextMethod(
    'public async ensureListenAudioCapture(',
    'private startCaptureChannels(',
  ));
  const stopIdx = body.search(/this\.stopAudioTest\s*\(/);
  assert.ok(
    stopIdx >= 0,
    'BUG: ensureListenAudioCapture must call this.stopAudioTest() before opening meeting captures (Listen can start capture while Settings meters still hold the mic)',
  );
  const setupIdx = body.search(/this\.setupSystemAudioPipeline\s*\(/);
  assert.ok(setupIdx >= 0, 'sanity: ensureListenAudioCapture still calls setupSystemAudioPipeline');
  assert.ok(
    stopIdx < setupIdx,
    `BUG: stopAudioTest must run before setupSystemAudioPipeline in ensureListenAudioCapture (stopIdx=${stopIdx}, setupIdx=${setupIdx})`,
  );
});
