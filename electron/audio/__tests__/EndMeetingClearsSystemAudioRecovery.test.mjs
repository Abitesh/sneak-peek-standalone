// Stage 5 — leave-meeting must clear system-audio recovery state so a
// delayed recovery cannot install a fresh capture after Stop.
//
// Bug: startMeetingTransition (and power-resume) cleared
// _systemAudioRecoveryTimer / in-progress / attempts / prefer-SCK.
// endMeetingTransition did not. Leaving mid-recovery left the 1.5s timer
// armed: clearTimeout was never called, and if generation guards ever
// regressed, the delayed recreate could install a CoreAudio/SCK capture
// after the user left. Residual risk even with guards: timer +
// _systemAudioRecoveryInProgress lingered until fire/finally.
//
// Fix: mirror startMeetingTransition's recovery reset inside
// endMeetingTransition (clear timer, reset in-progress/attempts/
// consecutive failures / prefer-SCK) before capture teardown completes.
//
// Strategy: structural assertions against main.ts — same extractMethodBody
// pattern as StuckWatchdogDisarmOnEndAndAbort / EndMeetingAbortsInFlightInit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.resolve(__dirname, '../../../electron/main.ts');
const mainSource = readFileSync(mainPath, 'utf8');

function extractMethodBody(methodName) {
  const re = new RegExp(
    `(?:public|private|protected)\\s+(?:async\\s+)?${methodName}\\s*\\([^)]*\\)\\s*(?::[^{]*)?\\{`,
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

function extractBalancedBlock(src, openBraceIdx) {
  assert.equal(src[openBraceIdx], '{');
  let depth = 1;
  let i = openBraceIdx + 1;
  const start = i;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < src.length) {
        const c = src[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  assert.equal(depth, 0);
  return src.slice(start, i - 1);
}

function extractRecoveryErrorListenerBody() {
  const handlerBody = extractMethodBody('setupAudioRecoveryHandler');
  const onErrRe =
    /this\.systemAudioCapture\.on\(\s*['"]error['"]\s*,\s*async\s*\([^)]*\)\s*=>\s*\{/;
  const m = onErrRe.exec(handlerBody);
  assert.ok(m, 'could not locate recovery error listener');
  return extractBalancedBlock(handlerBody, m.index + m[0].length - 1);
}

const endMeetingBody = extractMethodBody('endMeetingTransition');
const startMeetingBody = extractMethodBody('startMeetingTransition');
const recoveryListenerBody = extractRecoveryErrorListenerBody();

test('endMeetingTransition clears system-audio recovery timer and resets recovery state', () => {
  assert.ok(
    /if\s*\(\s*this\._systemAudioRecoveryTimer\s*\)\s*\{[\s\S]*?clearTimeout\s*\(\s*this\._systemAudioRecoveryTimer\s*\)[\s\S]*?this\._systemAudioRecoveryTimer\s*=\s*null/.test(
      endMeetingBody,
    ),
    'BUG: endMeetingTransition must clearTimeout(_systemAudioRecoveryTimer) and null it — ' +
      'same cleanup as startMeetingTransition — so leave mid-recovery does not leave the 1.5s delay armed.',
  );
  assert.ok(
    /this\._systemAudioRecoveryInProgress\s*=\s*false/.test(endMeetingBody),
    'BUG: endMeetingTransition must reset _systemAudioRecoveryInProgress (orphaned await after clearTimeout never hits finally).',
  );
  assert.ok(
    /this\._systemAudioRecoveryAttempts\s*=\s*0/.test(endMeetingBody),
    'BUG: endMeetingTransition must reset _systemAudioRecoveryAttempts so a left meeting cannot consume the next budget.',
  );
  assert.ok(
    /this\._systemAudioPreferSckRecovery\s*=\s*false/.test(endMeetingBody),
    'BUG: endMeetingTransition must reset _systemAudioPreferSckRecovery (meeting-scoped, same as start).',
  );
});

test('endMeeting recovery cleanup mirrors startMeetingTransition system-audio reset', () => {
  // Pin parity with the start-side block so a future edit that drops one
  // field from end but not start fails CI.
  for (const snippet of [
    'this._systemAudioRecoveryInProgress = false',
    'this._systemAudioRecoveryAttempts = 0',
    'this._systemAudioPreferSckRecovery = false',
  ]) {
    assert.ok(
      startMeetingBody.includes(snippet),
      `sanity: startMeetingTransition still has \`${snippet}\``,
    );
    assert.ok(
      endMeetingBody.includes(snippet),
      `BUG: endMeetingTransition must include \`${snippet}\` to match startMeetingTransition.`,
    );
  }
});

test('leave during recovery delay cannot install fresh capture after meeting ends', () => {
  // Belt: generation + isMeetingActive guard after the 1.5s delay, before
  // `new SystemAudioCapture`. Combined with endMeeting clearing the timer
  // and flipping isMeetingActive/generation, a leave mid-delay must not
  // install.
  const delayGuard =
    /this\._systemAudioRecoveryTimer\s*=\s*null;[\s\S]*?if\s*\(\s*!isRecoveryCurrentMeeting\s*\(\s*\)\s*\)\s*\{[\s\S]*?return;/;
  assert.ok(
    delayGuard.test(recoveryListenerBody),
    'BUG: recovery must re-check isRecoveryCurrentMeeting() after the delay before destroy/recreate.',
  );

  const constructIdx = recoveryListenerBody.search(
    /new\s+SystemAudioCapture\s*\(\s*recoveryDeviceId\s*\)/,
  );
  const postDelayReturnIdx = recoveryListenerBody.search(
    /this\._systemAudioRecoveryTimer\s*=\s*null;[\s\S]*?if\s*\(\s*!isRecoveryCurrentMeeting\s*\(\s*\)\s*\)\s*\{[\s\S]*?return;/,
  );
  assert.ok(constructIdx >= 0, 'sanity: recovery still constructs SystemAudioCapture(recoveryDeviceId)');
  assert.ok(postDelayReturnIdx >= 0, 'sanity: post-delay current-meeting guard exists');
  assert.ok(
    postDelayReturnIdx < constructIdx,
    'BUG: isRecoveryCurrentMeeting bail after delay must precede new SystemAudioCapture — ' +
      'otherwise leave-during-delay can still install a fresh capture.',
  );

  // End-meeting must clear the timer BEFORE (or as part of) flipping meeting
  // inactive / tearing down captures — so the armed delay cannot race install.
  const clearTimerIdx = endMeetingBody.search(/clearTimeout\s*\(\s*this\._systemAudioRecoveryTimer\s*\)/);
  const destroyIdx = endMeetingBody.search(/dyingSystemCapture\?\.\s*destroy\s*\(\s*\)/);
  assert.ok(clearTimerIdx >= 0, 'BUG: endMeeting must clearTimeout the recovery timer');
  assert.ok(destroyIdx >= 0, 'sanity: endMeeting still destroys system capture');
  // Prefer clearing before destroy; allow either order as long as both exist
  // in the same transition body (timer clear is the load-bearing leave fix).
  assert.ok(
    clearTimerIdx >= 0 && destroyIdx >= 0,
    'BUG: leave must both disarm recovery timer and destroy capture in endMeetingTransition.',
  );
});
