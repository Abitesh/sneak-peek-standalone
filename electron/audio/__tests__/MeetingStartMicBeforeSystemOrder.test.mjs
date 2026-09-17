// Regression test for the lazy-mic-init meeting-start hang (2026-06-27).
//
// Symptom: after making MicrophoneCapture constructor HAL-clean, meeting start
// could freeze on macOS. Logs stopped after:
//   [Microphone] Device: MacBook Air Microphone, Rate: 48000Hz, ...
// and never reached `[MicrophoneCapture] Starting native capture...`.
//
// Root cause: MicrophoneCapture.start() now constructs the cpal input stream.
// If SystemAudioCapture.start() runs first, its CoreAudio Aggregate Device IO
// proc is already active while cpal negotiates the input stream; macOS HAL can
// deadlock. Pre-lazy-init, the mic native monitor was constructed during
// setupSystemAudioPipeline()/reconfigureAudio(), before the system tap started.
//
// Invariant: every active-meeting path that starts both captures must start the
// microphone capture before the system-audio capture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const mainSource = fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8');

function extractMethodBody(methodName) {
  // The return-type annotation may itself contain braces —
  // `startCaptureChannels(...): { mic: boolean; system: boolean } {`. The old
  // `(?::[^{]*)?\{` stopped at the FIRST `{`, which is the return type's, so
  // brace-scanning extracted `mic: boolean; system: boolean` as the "body".
  // Consume a one-level brace group as a unit so the `{` we land on is the body.
  const re = new RegExp(`(?:public|private|protected)\\s+(?:async\\s+)?${methodName}\\s*\\([^)]*\\)\\s*(?::\\s*[^{;=]*(?:\\{[^{}]*\\}\\s*)?)?\\s*\\{`);
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
    // strip block comments before line comments so `//` inside a block comment
    // can't confuse the second replacement
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    // Preserve string length roughly with empty literals. The exact indices do
    // not need to map to original source; we only compare ordering inside the
    // scrubbed code body.
    .replace(/`(?:\\.|[^`])*`/g, '``')
    .replace(/'(?:\\.|[^'])*'/g, "''")
    .replace(/"(?:\\.|[^"])*"/g, '""');
}

function firstIndexOf(re, body) {
  const m = re.exec(scrubNonCode(body));
  return m ? m.index : -1;
}

function assertMicStartsBeforeSystem(body, label, depth = 0) {
  // A path may start the channels inline, or delegate to the shared
  // startCaptureChannels() helper introduced with F-105 (per-channel failure
  // isolation: a mic throw must not skip the system channel and every
  // downstream step). The helper starts mic first and documents this very
  // invariant, but the calls left the caller — so follow the delegation rather
  // than reporting "could not find microphoneCapture.start()" on correct code.
  const scrubbed = scrubNonCode(body);
  if (
    depth === 0
    && /this\.startCaptureChannels\(/.test(scrubbed)
    && !/this\.microphoneCapture\??\.start\(\)/.test(scrubbed)
  ) {
    assertMicStartsBeforeSystem(
      extractMethodBody('startCaptureChannels'),
      `${label} -> startCaptureChannels`,
      depth + 1,
    );
    return;
  }
  const micIdx = firstIndexOf(/this\.microphoneCapture\??\.start\(\)/, body);
  const sysIdx = firstIndexOf(/(?:this\.systemAudioCapture\??|systemCapturePausedByMicRecovery)\.start\(\)/, body);
  assert.ok(micIdx >= 0, `${label}: could not find microphoneCapture.start()`);
  assert.ok(sysIdx >= 0, `${label}: could not find systemAudioCapture.start()`);
  assert.ok(
    micIdx < sysIdx,
    `${label}: microphoneCapture.start() must run before systemAudioCapture.start(). ` +
    `Lazy mic init constructs the cpal input stream; starting CoreAudio system tap first can deadlock macOS HAL. ` +
    `micIdx=${micIdx}, sysIdx=${sysIdx}`,
  );
}

test('startMeetingTransition starts microphone before system audio', () => {
  assertMicStartsBeforeSystem(extractMethodBody('startMeetingTransition'), 'startMeetingTransition');
});

test('reconfigureAudio restarts microphone before system audio during active meetings', () => {
  assertMicStartsBeforeSystem(extractMethodBody('reconfigureAudio'), 'reconfigureAudio');
});

test('reconfigureSttProvider restarts microphone before system audio during active meetings', () => {
  assertMicStartsBeforeSystem(extractMethodBody('_doReconfigureSttProvider'), '_doReconfigureSttProvider');
});

test('restartCapturesAfterResume restarts microphone before system audio', () => {
  assertMicStartsBeforeSystem(extractMethodBody('restartCapturesAfterResume'), 'restartCapturesAfterResume');
});

test('setupMicRecoveryHandler restarts microphone before resuming system audio', () => {
  assertMicStartsBeforeSystem(extractMethodBody('setupMicRecoveryHandler'), 'setupMicRecoveryHandler');
});

test('_doReconfigureSttProvider disables mic pre-warm immediately before stopping mic', () => {
  const body = scrubNonCode(extractMethodBody('_doReconfigureSttProvider'));
  const pattern = /this\.microphoneCapture\?\.disablePreWarm\(\);/;
  assert.ok(
    pattern.test(body),
    '_doReconfigureSttProvider must call microphoneCapture.disablePreWarm() before tearing down the mic wrapper.',
  );
});

test('_doReconfigureSttProvider awaits destroy() on both mic and system captures, not only stop()', () => {
  const body = scrubNonCode(extractMethodBody('_doReconfigureSttProvider'));
  // F-104 snapshot-then-destroy: null the fields, then await destroy() on the
  // dying wrappers so watcher/recovery ticks do not see a half-dead instance.
  assert.match(
    body,
    /dyingMicrophoneCapture\?\.destroy\(\)/,
    '_doReconfigureSttProvider must await microphoneCapture.destroy() (F-104: stop()+start() on the same wrapper races deferred native teardown).',
  );
  assert.match(
    body,
    /dyingSystemAudioCapture\?\.destroy\(\)/,
    '_doReconfigureSttProvider must await systemAudioCapture.destroy() — system stop()+start() is the F-104 "Capture already running" path.',
  );
  assert.match(
    body,
    /await\s+Promise\.all\s*\(/,
    '_doReconfigureSttProvider must await both capture destroy() promises (not fire-and-forget stop()).',
  );
  // Same-wrapper restart is the documented-unsafe pattern. Fresh wrappers
  // come from setupSystemAudioPipeline after destroy+null.
  assert.doesNotMatch(
    body,
    /this\.microphoneCapture\?\.stop\(\)[\s\S]{0,400}this\.microphoneCapture\?\.start\(\)/,
    '_doReconfigureSttProvider must not stop()+start() the same microphoneCapture wrapper.',
  );
  assert.doesNotMatch(
    body,
    /this\.systemAudioCapture\?\.stop\(\)[\s\S]{0,400}this\.systemAudioCapture\?\.start\(\)/,
    '_doReconfigureSttProvider must not stop()+start() the same systemAudioCapture wrapper.',
  );
});
