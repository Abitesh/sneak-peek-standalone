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
    /const handleStartListening = \(\) => \{[\s\S]*?setIsManualRecording\(true\);[\s\S]*?setIsExpanded\(true\);[\s\S]*?getMeetingActive\(\)[\s\S]*?startMeeting\(\)/,
    'BUG: Listen must set isManualRecording, force the overlay open (setIsExpanded(true)), and wire the real meeting mic/STT path (getMeetingActive/startMeeting) instead of only flipping a UI flag.',
  );
  assert.match(
    nativelyInterfaceSource,
    /const handleStartListening = \(\) => \{[\s\S]*?setVoiceInput\(''\);[\s\S]*?voiceInputRef\.current = '';[\s\S]*?setManualTranscript\(''\);[\s\S]*?manualTranscriptRef\.current = '';[\s\S]*?interviewerListenRef\.current = '';/,
    'BUG: Listen must clear user AND interviewer Listen buffers before starting a new turn.',
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
