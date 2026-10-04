import assert from 'node:assert/strict';
import test from 'node:test';
import { understandTurn } from '../../../../dist-electron/electron/context-intelligence/question/question-resolver.js';
import { emptyState } from '../../../../dist-electron/electron/context-intelligence/question/conversation-state.js';

const state = emptyState({ userId: 'local', sessionId: 's1' });
state.turns = [
  { id: 't1', role: 'user', speaker: 'user', text: 'Why did you use Redis in Linkship', timestamp: 1, finalized: true, source: 'manual' },
  { id: 't2', role: 'assistant', speaker: 'assistant', text: 'For caching.', timestamp: 2, finalized: true, source: 'assistant' },
];
state.currentTurnId = 't2';
state.previousQuestion = 'Why did you use Redis in Linkship';
state.activeTopic = 'Redis';

function u(text, extra = {}) {
  return understandTurn({ manualQuestion: text, conversationState: state, ...extra });
}

test('understands general definition without depending on question mark', () => {
  const a = u('What is Redis');
  const b = u('What is Redis?');
  assert.equal(a.intent, 'general-question');
  assert.equal(b.intent, 'general-question');
  assert.equal(a.isQuestion, true);
});

test('recognizes project questions and project technology usage', () => {
  assert.equal(u('Why did you use Redis in Linkship?').intent, 'project-question');
  assert.equal(u('What did I use PostgreSQL for?').intent, 'project-question');
});

test('recognizes explicit personal context', () => {
  assert.equal(u('Tell me about my experience.').intent, 'personal-question');
});

test('recognizes document context', () => {
  assert.equal(u('What does this document say').intent, 'document-question');
});

test('recognizes follow-ups and previous-context references', () => {
  const a = u('And why?');
  assert.equal(a.followUp, true);
  assert.equal(a.refersToPreviousContext, true);
  assert.equal(a.intent, 'follow-up');
  assert.equal(u('Explain that again.').intent, 'follow-up');
});

test('recognizes refinement and response shape', () => {
  const a = u('Make it longer.');
  assert.equal(a.intent, 'refinement');
  assert.equal(a.responseShape, 'detailed');
});

test('recognizes coding request', () => {
  const a = u('Give me code.');
  assert.equal(a.intent, 'coding-request');
  assert.equal(a.responseShape, 'code');
});

test('recognizes screen-specific request only when screen context exists', () => {
  assert.equal(u('What is this error?', { hasScreenContext: true }).intent, 'screen-question');
});

test('recognizes a contextual statement requiring response without calling it a question', () => {
  const a = u("I don't understand why Redis was used.");
  assert.equal(a.intent, 'conversational-response');
  assert.equal(a.isQuestion, false);
});

test('extracts requested duration', () => {
  assert.equal(u('Explain Redis in 2 minutes.').requestedDuration, 120);
});
