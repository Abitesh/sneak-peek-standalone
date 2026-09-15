// Sprint S8 (Problems 15-17, 41-44, 47-48): Listen/Analyze + audio states +
// non-blocking UI. Source-inspection tests — verifies the wiring described in
// the plan without needing a full Electron/React render harness (the rest of
// this file's neighbors follow the same pattern, e.g.
// NativelyInterfaceStreamingMathWiring2026_08_07.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const nativelyInterfaceSource = fs.readFileSync(path.resolve(here, '../NativelyInterface.tsx'), 'utf8');
const topControlBarSource = fs.readFileSync(path.resolve(here, '../TopControlBar.tsx'), 'utf8');

test('Listen actually starts the mic/STT pipeline, expands the overlay, and clears buffers', () => {
  assert.match(
    nativelyInterfaceSource,
    /const handleStartListening = \(\) => \{[\s\S]*?setIsManualRecording\(true\);[\s\S]*?setIsExpanded\(true\);[\s\S]*?getMeetingActive\(\)[\s\S]*?ensureListenAudioCapture/,
    'BUG: Listen must set isManualRecording, force the overlay open (setIsExpanded(true)), verify meeting active, and ensure mic+system capture (ensureListenAudioCapture).',
  );
  assert.match(
    nativelyInterfaceSource,
    /const handleStartListening = \(\) => \{[\s\S]*?setVoiceInput\(''\);[\s\S]*?voiceInputRef\.current = '';[\s\S]*?setManualTranscript\(''\);[\s\S]*?manualTranscriptRef\.current = '';[\s\S]*?interviewerListenRef\.current = '';/,
    'BUG: Listen must clear user AND interviewer Listen buffers before starting a new turn.',
  );
});

test('Listen ensures system audio capture is running (Ambient AI Chat / failed starts)', () => {
  assert.match(
    nativelyInterfaceSource,
    /ensureListenAudioCapture/,
    'BUG: Listen must call ensureListenAudioCapture so system/loopback starts even when Ambient AI Chat skipped capture at meeting start.',
  );
  const mainSource = fs.readFileSync(
    path.resolve(here, '../../../electron/main.ts'),
    'utf8',
  );
  assert.match(
    mainSource,
    /async ensureListenAudioCapture\(\)/,
    'BUG: main process must expose ensureListenAudioCapture for Listen.',
  );
  assert.match(
    mainSource,
    /Ambient AI Chat is ON — starting mic\/system capture/,
    'BUG: Listen must override Ambient AI Chat and start capture when the user explicitly presses Listen.',
  );
});

test('Analyze falls back to SessionTracker interviewer lines when Listen buffers are empty', () => {
  assert.match(
    nativelyInterfaceSource,
    /getListenWindowTranscript/,
    'BUG: Analyze must query getListenWindowTranscript when Them/You Listen buffers are empty.',
  );
});

test('Listen accumulates system/interviewer audio during a session (other person on the call)', () => {
  assert.match(
    nativelyInterfaceSource,
    /isRecordingRef\.current && transcript\.speaker === 'interviewer'/,
    'BUG: while Listen is active, interviewer (system audio) transcripts must enter Listen-scoped buffers — not only the rolling bar.',
  );
  assert.match(
    nativelyInterfaceSource,
    /Interviewer: \$\{them\}/,
    'BUG: Analyze must include the other person\'s speech in the question sent to the AI.',
  );
});

test('TopControlBar exposes separate Listen and Analyze actions; Answer stays handleWhatToSay', () => {
  assert.match(
    topControlBarSource,
    /onListen:\s*\(\)\s*=>\s*void;[\s\S]*?onAnalyze:\s*\(\)\s*=>\s*void;/,
    'BUG: TopControlBar must declare distinct onListen and onAnalyze props.',
  );
  assert.match(nativelyInterfaceSource, /onListen=\{\(\) => handleStartListening\(\)\}/);
  assert.match(nativelyInterfaceSource, /onAnalyze=\{\(\) => void handleAnalyzeNow\(\)\}/);
  assert.match(nativelyInterfaceSource, /onAnswer=\{\(\) => void handleWhatToSay\(\)\}/);
});

test('Analyze auto-stops Listen, finalizes STT, and sends to the AI', () => {
  assert.match(
    nativelyInterfaceSource,
    /const handleAnalyzeNow = async \(\) => \{\s*if \(!isManualRecording\) return;/,
    'BUG: Analyze must no-op unless a Listen session is active.',
  );
  assert.match(
    nativelyInterfaceSource,
    /const handleAnalyzeNow = async \(\) => \{[\s\S]*?setIsManualRecording\(false\);[\s\S]*?finalizeMicSTT/,
    'BUG: Analyze must stop recording and finalize the mic STT turn.',
  );
});

test('finalizeMicSTT flushes BOTH user mic and system/interviewer STT channels', () => {
  const mainSource = fs.readFileSync(
    path.resolve(here, '../../../electron/main.ts'),
    'utf8',
  );
  assert.match(
    mainSource,
    /finalizeMicSTT\(\)[\s\S]*?googleSTT_User\?\.finalize[\s\S]*?googleSTT\?\.finalize/,
    'BUG: Analyze finalize must flush system audio STT as well as the user mic, or the other person\'s finals never land in Listen buffers.',
  );
});

test('the legacy combined toggle (hotkey / phone-bridge / quick-action chip) still dispatches to Listen/Analyze', () => {
  assert.match(
    nativelyInterfaceSource,
    /const handleAnswerNow = async \(\) => \{\s*if \(isManualRecording\) \{\s*await handleAnalyzeNow\(\);\s*\} else \{\s*handleStartListening\(\);\s*\}\s*\};/,
  );
});

test('a visible Listen->Analyze audio state machine exists with the four in-session states', () => {
  for (const state of ['listening', 'speaking', 'transcribing', 'processing']) {
    assert.match(
      nativelyInterfaceSource,
      new RegExp(`setAudioSessionState\\([^;]*['"\`]${state}['"\`]`),
      `BUG: missing a transition into audio state "${state}".`,
    );
  }
});

test('the live transcript / audio-state indicator renders independently of showAnswerPanel', () => {
  const indicatorIdx = nativelyInterfaceSource.indexOf("audioSessionState !== 'idle' && (");
  const panelIdx = nativelyInterfaceSource.indexOf('{showAnswerPanel && (');
  assert.ok(indicatorIdx > -1, 'BUG: expected an audioSessionState-gated indicator block.');
  assert.ok(panelIdx > -1, 'BUG: expected the showAnswerPanel-gated chat history block.');
  assert.ok(
    indicatorIdx < panelIdx,
    'BUG: the live-transcript/audio-state indicator must be a sibling rendered BEFORE (i.e. outside) the showAnswerPanel gate, not nested inside it — otherwise it disappears whenever showAnswerPanel is momentarily false during the Listen->Analyze handoff.',
  );
});

test('TopControlBar is a collapsible, non-blocking overlay (Problem 48)', () => {
  assert.match(topControlBarSource, /collapsedKey = 'natively_top_control_bar_collapsed'/);
  assert.match(topControlBarSource, /const \[collapsed, setCollapsed\] = useState/);
  assert.match(topControlBarSource, /toggleCollapsed/);
});

function extractBraceBody(source, marker) {
  const idx = source.indexOf(marker);
  assert.ok(idx >= 0, `could not locate ${marker}`);
  let i = idx + marker.length;
  let depth = 1;
  const start = i;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  assert.equal(depth, 0, `unbalanced braces after ${marker}`);
  return source.slice(start, i - 1);
}

const handleStartListeningBody = extractBraceBody(
  nativelyInterfaceSource,
  'const handleStartListening = () => {',
);
const onSessionResetBody = extractBraceBody(
  nativelyInterfaceSource,
  'onSessionReset(() => {',
);

test('Listen preserves arming across the session-reset Listen itself caused', () => {
  assert.match(
    nativelyInterfaceSource,
    /preserveListenOnResetRef\s*=\s*useRef\(/,
    'BUG: a one-shot preserveListenOnResetRef must exist so Listen-triggered startMeeting does not disarm the You-channel gate.',
  );
  assert.match(
    handleStartListeningBody,
    /if\s*\(\s*!active\s*\)\s*\{[\s\S]*preserveListenOnResetRef\.current\s*=\s*true[\s\S]*startMeeting\(/,
    'BUG: before startMeeting() from Listen, set preserveListenOnResetRef so the coming session-reset does not clear isRecordingRef.',
  );
  assert.match(
    onSessionResetBody,
    /resetChatState\(\)/,
    'BUG: onSessionReset must still run resetChatState() (messages + width collapse stay required).',
  );
  assert.match(
    onSessionResetBody,
    /preserveListenOnResetRef/,
    'BUG: onSessionReset must consume preserveListenOnResetRef.',
  );
  assert.match(
    onSessionResetBody,
    /isRecordingRef\.current\s*=\s*false/,
    'BUG: launcher startMeeting / endMeeting must still clear isRecordingRef when preserve is unset.',
  );
  assert.match(
    onSessionResetBody,
    /setIsManualRecording\(\s*false\s*\)/,
    'BUG: launcher startMeeting / endMeeting must still clear isManualRecording when preserve is unset.',
  );
  assert.doesNotMatch(
    onSessionResetBody,
    /resetChatState\(\);\s*isRecordingRef\.current\s*=\s*false/,
    'BUG: isRecordingRef must not be cleared unconditionally after resetChatState — Listen-triggered session-reset has to keep the push-to-talk gate armed.',
  );
});

test('Listen does not sleep 400ms before ensureListenAudioCapture', () => {
  assert.doesNotMatch(
    handleStartListeningBody,
    /setTimeout\([^,]+,\s*400\s*\)/,
    'BUG: the 400ms pause cannot wait out 5–7s audio init; ensureListenAudioCapture must await _audioInitPromise instead.',
  );
});

test('Listen warns on !status.mic the same way it warns on !status.system', () => {
  assert.match(
    handleStartListeningBody,
    /!status\.mic[\s\S]*?status\.message[\s\S]*?⚠️ \$\{status\.message\}/,
    'BUG: handleStartListening must surface status.message when mic capture did not start, not only when !status.system.',
  );
});

test('Listen disarms when ensureListenAudioCapture returns !ok', () => {
  assert.match(
    handleStartListeningBody,
    /!status\.ok[\s\S]*?isRecordingRef\.current\s*=\s*false[\s\S]*?setIsManualRecording\(\s*false\s*\)[\s\S]*?setAudioSessionState\(\s*['"]idle['"]\s*\)/,
    'BUG: if ensureListenAudioCapture fails (!status.ok), disarm Listen so the button is clickable again.',
  );
});

test('Listen disarms when startMeeting or ensureListenAudioCapture throws', () => {
  assert.match(
    handleStartListeningBody,
    /catch \(err\) \{[\s\S]*?preserveListenOnResetRef\.current\s*=\s*false[\s\S]*?isRecordingRef\.current\s*=\s*false[\s\S]*?setIsManualRecording\(\s*false\s*\)[\s\S]*?setAudioSessionState\(\s*['"]idle['"]\s*\)/,
    'BUG: if startMeeting throws (e.g. mic-permission-denied), disarm Listen and drop the preserve flag — otherwise the UI stays on Listening with no capture.',
  );
});
