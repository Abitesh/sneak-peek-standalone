// Stage 4 — FATAL no-samples with callback_invocations=0 must prefer SCK recovery.
//
// Bug: Native health check emits
//   "[SystemAudioCapture] FATAL: no audio samples …; callback_invocations=0; …"
// into SystemAudioCapture → setupAudioRecoveryHandler. Prefer-SCK
// (_systemAudioPreferSckRecovery) was only set on sustained zero-fill
// (wireSystemCapture health decision). A dead CoreAudio tap with zero
// IO callbacks therefore recovered with _lastRequestedOutputDeviceId and
// rebuilt CoreAudio again — infinite same-backend retry.
//
// Fix: when the recovery error message reports callback_invocations=0,
// set _systemAudioPreferSckRecovery = true BEFORE selecting recoveryDeviceId
// so `new SystemAudioCapture('sck')` is used for that meeting.
//
// Strategy: structural assertions against main.ts (same pattern as
// SystemAudioRecoveryRouteChangeMutex / Change55 zero-fill pin).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainTsPath = path.resolve(__dirname, '../../../electron/main.ts');
const source = readFileSync(mainTsPath, 'utf8');

function extractBalancedBlock(src, openBraceIdx) {
  assert.equal(src[openBraceIdx], '{', `expected '{' at index ${openBraceIdx}`);
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
  assert.equal(depth, 0, `unbalanced braces starting at ${openBraceIdx}`);
  return src.slice(start, i - 1);
}

function extractMethodBody(src, methodName) {
  const sigRe = new RegExp(
    `(?:private|public|protected)\\s+(?:async\\s+)?${methodName}\\s*\\([^)]*\\)\\s*(?::\\s*[^\\{]+)?\\{`,
  );
  const m = sigRe.exec(src);
  assert.ok(m, `could not locate ${methodName} signature in main.ts`);
  const openBraceIdx = m.index + m[0].length - 1;
  return extractBalancedBlock(src, openBraceIdx);
}

function extractRecoveryErrorListenerBody(src) {
  const handlerBody = extractMethodBody(src, 'setupAudioRecoveryHandler');
  const onErrRe = /this\.systemAudioCapture\.on\(\s*['"]error['"]\s*,\s*async\s*\([^)]*\)\s*=>\s*\{/;
  const m = onErrRe.exec(handlerBody);
  assert.ok(
    m,
    "could not locate `this.systemAudioCapture.on('error', async (...) => {` inside setupAudioRecoveryHandler",
  );
  const openBraceIdx = m.index + m[0].length - 1;
  return extractBalancedBlock(handlerBody, openBraceIdx);
}

const recoveryErrorListenerBody = extractRecoveryErrorListenerBody(source);

test('FATAL callback_invocations=0 sets _systemAudioPreferSckRecovery before recoveryDeviceId', () => {
  // Must detect the native FATAL no-samples stats string and flip prefer-SCK.
  const preferSetRe =
    /callback_invocations\s*[=:\\s]*0[\s\S]{0,400}?this\._systemAudioPreferSckRecovery\s*=\s*true/;
  // Also accept the reverse order within a small window if the flag is set
  // after a message match helper — require both the regex probe and the assign.
  const hasCallbackZeroProbe =
    /callback_invocations\s*[=\\s]*0/.test(recoveryErrorListenerBody) ||
    /callback_invocations\s*=\s*0/.test(recoveryErrorListenerBody) ||
    /\/callback_invocations\\s*=\\s*0\//.test(recoveryErrorListenerBody) ||
    /callback_invocations=0/.test(recoveryErrorListenerBody);

  assert.ok(
    hasCallbackZeroProbe,
    'BUG: setupAudioRecoveryHandler error listener must inspect err.message for ' +
      'callback_invocations=0 (native FATAL no-samples stats) before recreating capture.',
  );

  const preferIdx = recoveryErrorListenerBody.search(
    /this\._systemAudioPreferSckRecovery\s*=\s*true/,
  );
  const deviceIdIdx = recoveryErrorListenerBody.search(
    /const\s+recoveryDeviceId\s*=\s*this\._systemAudioPreferSckRecovery/,
  );

  assert.ok(
    preferIdx >= 0,
    'BUG: FATAL callback_invocations=0 path must set this._systemAudioPreferSckRecovery = true ' +
      '(zero-fill already does this; dead-callback FATAL did not).',
  );
  assert.ok(
    deviceIdIdx >= 0,
    'sanity: recovery still selects deviceId from _systemAudioPreferSckRecovery',
  );
  assert.ok(
    preferIdx < deviceIdIdx,
    'BUG: prefer-SCK must be set BEFORE `const recoveryDeviceId = this._systemAudioPreferSckRecovery ? \'sck\' : …` ' +
      'so the recreate uses SystemAudioCapture(\'sck\').',
  );

  // Keep the probe tightly coupled to the prefer assign (same listener, nearby).
  assert.ok(
    preferSetRe.test(recoveryErrorListenerBody) ||
      Math.abs(
        recoveryErrorListenerBody.search(/callback_invocations/) - preferIdx,
      ) < 500,
    'BUG: callback_invocations=0 detection must be adjacent to the prefer-SCK assign in the recovery listener.',
  );
});

test('recovery still constructs SystemAudioCapture(recoveryDeviceId) after prefer-SCK', () => {
  assert.ok(
    /new\s+SystemAudioCapture\s*\(\s*recoveryDeviceId\s*\)/.test(recoveryErrorListenerBody),
    'sanity: fresh capture must still use recoveryDeviceId (which is \'sck\' when prefer is set).',
  );
});
