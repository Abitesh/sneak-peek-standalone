import fs from 'node:fs';
const s = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const must = (re, label) => { if (!re.test(s)) throw new Error(`FAIL: ${label}`); };

must(/_systemAudioPreferSckRecovery = false/, 'meeting-scoped SCK recovery state exists');
must(/this\._systemAudioPreferSckRecovery = false;/, 'SCK recovery state resets at meeting start');
must(/zeroFillRecoveryTriggered = false/, 'zero-fill trigger is one-shot per capture instance');
must(/sustained zero-valued audio; switching to ScreenCaptureKit recovery/, 'zero-fill recovery error is explicit');
must(/this\._systemAudioPreferSckRecovery = true;/, 'zero-fill selects SCK recovery');
must(/capture\.emit\('error', fallbackError\)/, 'zero-fill enters the existing recovery pipeline');
must(/const recoveryDeviceId = this\._systemAudioPreferSckRecovery\s*\?\s*'sck'/, 'recovery selects the SCK backend');
must(/new SystemAudioCapture\(recoveryDeviceId\)/, 'fresh capture uses the selected recovery backend');
must(/:\s*this\._lastRequestedOutputDeviceId;/, 'ordinary recovery still uses the requested/default output');
console.log('Change 55 system-audio zero-fill SCK fallback verification passed.');
