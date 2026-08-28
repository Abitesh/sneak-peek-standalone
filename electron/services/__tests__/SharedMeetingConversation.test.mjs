import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = path.resolve(process.cwd(), 'dist-electron/electron/SessionTracker.js');
const { SessionTracker } = await import(pathToFileURL(dist).href);
const managerDist = path.resolve(process.cwd(), 'dist-electron/electron/IntelligenceManager.js');
const { IntelligenceManager } = await import(pathToFileURL(managerDist).href);

const add = (tracker, speaker, text, timestamp) => tracker.addTranscript({
  speaker,
  text,
  timestamp,
  final: true,
  origin: speaker === 'interviewer' ? 'stt' : 'manual_chat',
});

describe('shared meeting conversation', () => {
  test('keeps Ask, Listen, Screen, and AI events in chronological context', () => {
    const tracker = new SessionTracker();
    add(tracker, 'user', 'Explain my authentication project.', 1);
    add(tracker, 'interviewer', 'Why did you choose Redis?', 2);
    tracker.addAssistantMessage('The project used Redis for fast session lookups.', undefined, 'manual_chat');
    tracker.addAssistantMessage('[SCREEN ANALYSIS]\nThe diagram shows an API connected to Redis.', undefined, 'screenshot');

    const context = tracker.getFullSessionContext();
    assert.match(context, /ME]: Explain my authentication project/);
    assert.match(context, /INTERVIEWER]: Why did you choose Redis/);
    assert.match(context, /ASSISTANT]: The project used Redis/);
    assert.match(context, /SCREEN ANALYSIS/);
    assert.ok(context.indexOf('Explain my authentication project') < context.indexOf('Why did you choose Redis'));
    assert.ok(context.indexOf('Why did you choose Redis') < context.indexOf('SCREEN ANALYSIS'));
  });

  test('a new meeting reset removes the previous meeting conversation', () => {
    const tracker = new SessionTracker();
    tracker.setMeetingMetadata({ id: 'meeting-a' });
    add(tracker, 'user', 'Meeting A project details', 1);
    tracker.addAssistantMessage('Meeting A answer with private details.', undefined, 'manual_chat');
    tracker.reset();
    add(tracker, 'interviewer', 'Meeting B question', 2);

    const context = tracker.getFullSessionContext();
    assert.doesNotMatch(context, /Meeting A/);
    assert.match(context, /Meeting B question/);
    assert.equal(tracker.getLastAssistantMessage('manual_chat'), null);
    assert.equal(tracker.getMeetingMetadata(), null);
  });

  test('screen observations are bounded and do not store image data', () => {
    const tracker = new SessionTracker();
    const observation = 'x'.repeat(5000);
    IntelligenceManager.prototype.addScreenAnalysis.call({ session: tracker }, observation);
    const context = tracker.getFullSessionContext();
    assert.ok(context.length < 2600);
    assert.match(context, /SCREEN ANALYSIS/);
  });
});
