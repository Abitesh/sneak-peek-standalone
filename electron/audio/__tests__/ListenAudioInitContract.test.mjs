// Source-contract: Listen audio init must wait for deferred meeting capture,
// report startCaptureChannels success (not object presence), and flip
// _listenAudioActive so later resume/recovery/reconfigure actually start().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(path.resolve(__dirname, '../../../electron/main.ts'), 'utf8');

function sliceUntilNextMethod(startMarker, nextMarker) {
  const start = mainSource.indexOf(startMarker);
  assert.ok(start >= 0, `could not locate ${startMarker}`);
  const end = mainSource.indexOf(nextMarker, start + startMarker.length);
  assert.ok(end >= 0, `could not locate ${nextMarker} after ${startMarker}`);
  return mainSource.slice(start, end);
}

function extractMethodBody(methodName) {
  const methodRe = new RegExp(
    `(?:public|private|protected)\\s+(?:async\\s+)?${methodName}\\s*\\([^)]*\\)\\s*(?::\\s*[^{;=]*(?:\\{[^{}]*\\}\\s*)?)?\\s*\\{`,
  );
  const match = methodRe.exec(mainSource);
  assert.ok(match, `could not locate ${methodName}`);
  let i = match.index + match[0].length;
  let depth = 1;
  const start = i;
  while (i < mainSource.length && depth > 0) {
    const ch = mainSource[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  assert.equal(depth, 0, `unbalanced braces while extracting ${methodName}`);
  return mainSource.slice(start, i - 1);
}

const ensureBody = sliceUntilNextMethod(
  'public async ensureListenAudioCapture(',
  'private startCaptureChannels(',
);
const startMeetingBody = extractMethodBody('startMeetingTransition');

test('ensureListenAudioCapture awaits _audioInitPromise before touching captures', () => {
  const awaitIdx = ensureBody.search(/await\s+this\._audioInitPromise/);
  const setupIdx = ensureBody.search(/setupSystemAudioPipeline/);
  const startIdx = ensureBody.search(/startCaptureChannels/);
  assert.ok(awaitIdx >= 0, 'BUG: ensureListenAudioCapture must await this._audioInitPromise (Listen can race deferred 5–7s meeting audio init).');
  assert.ok(setupIdx >= 0, 'sanity: ensureListenAudioCapture still builds the pipeline when objects are missing.');
  assert.ok(startIdx >= 0, 'sanity: ensureListenAudioCapture still starts capture channels.');
  assert.ok(
    awaitIdx < setupIdx && awaitIdx < startIdx,
    'BUG: await _audioInitPromise must run before setupSystemAudioPipeline / startCaptureChannels.',
  );
});

test('ensureListenAudioCapture reports mic/system from startCaptureChannels, not object presence', () => {
  assert.match(
    ensureBody,
    /const\s+started\s*=\s*this\.startCaptureChannels\(\s*['"]ensureListenAudioCapture['"]\s*\)/,
    'BUG: capture the startCaptureChannels return value — object existence is not start success (F-105).',
  );
  assert.match(
    ensureBody,
    /out\.mic\s*=\s*started\.mic/,
    'BUG: out.mic must come from startCaptureChannels().mic, not microphoneCapture/STT object presence.',
  );
  assert.match(
    ensureBody,
    /out\.system\s*=\s*started\.system/,
    'BUG: out.system must come from startCaptureChannels().system, not systemAudioCapture/STT object presence.',
  );
  assert.doesNotMatch(
    ensureBody,
    /out\.mic\s*=\s*!!\(\s*this\.microphoneCapture/,
    'BUG: object-presence out.mic lies when start() failed.',
  );
  assert.doesNotMatch(
    ensureBody,
    /out\.system\s*=\s*!!\(\s*this\.systemAudioCapture/,
    'BUG: object-presence out.system lies when start() failed.',
  );
});

test('ensureListenAudioCapture sets _listenAudioActive when a channel started', () => {
  assert.match(
    ensureBody,
    /started\.(mic|system)[\s\S]*this\._listenAudioActive\s*=\s*true/,
    'BUG: Listen ensure must set _listenAudioActive true when started.mic || started.system so resume/recovery/reconfigure call start().',
  );
});

test('startMeeting sets _listenAudioActive true after capture start, not on Ambient Chat skip', () => {
  const captureIdx = startMeetingBody.indexOf("startCaptureChannels('startMeeting', false)");
  assert.ok(captureIdx >= 0, 'sanity: startMeeting deferred init must call startCaptureChannels.');
  const after = startMeetingBody.slice(captureIdx);
  const flagIdx = after.search(/this\._listenAudioActive\s*=\s*true/);
  assert.ok(
    flagIdx >= 0,
    'BUG: after startMeeting startCaptureChannels, set _listenAudioActive = true (today the flag is only ever cleared).',
  );
  const ambientSkipIdx = after.indexOf('Ambient AI Chat enabled — skipping');
  assert.ok(
    ambientSkipIdx < 0 || flagIdx < ambientSkipIdx,
    'BUG: _listenAudioActive = true belongs in the capture-start branch, not after the Ambient AI Chat skip.',
  );
});
