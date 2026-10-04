import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const storeBase = path.resolve(process.cwd(), 'dist-electron/electron/context-intelligence/question');
const ctxBase = path.resolve(process.cwd(), 'dist-electron/electron/intelligence/engine');
const store = await import(pathToFileURL(path.join(storeBase, 'conversation-state-store.js')).href);
const { getRecentConversationContext } = await import(pathToFileURL(path.join(ctxBase, 'TranscriptContext.js')).href);

function turn(sessionId, i, role = 'interviewer', text = `turn ${i}`, timestamp = i * 1000) {
  return store.appendConversationTurn({
    sessionId,
    role,
    speaker: role,
    text,
    timestamp,
    finalized: true,
    source: role === 'interviewer' ? 'transcript' : 'manual',
    requestSequence: i,
  });
}

describe('bounded transcript context', () => {
  beforeEach(() => store.clearConversationState());

  test('100 turns are bounded to the configured recent window', () => {
    for (let i = 1; i <= 100; i++) turn('s1', i);
    const current = store.getCurrentConversationTurn('s1');
    const result = getRecentConversationContext({
      sessionId: 's1',
      currentTurn: current,
      recentTurnLimit: 12,
      recentWindowSeconds: 1000,
    });

    assert.equal(result.recentTranscriptWindow.length, 12);
    assert.equal(result.currentTurn?.id, current.id);
    assert.equal(result.currentTurnIncluded, true);
    assert.equal(result.recentTranscriptWindow.at(-1)?.id, current.id);
    assert.equal(result.olderConversationTurnsAvailable, 88);
  });

  test('current turn is never lost when it is newer than the stored window', () => {
    turn('s2', 1, 'user', 'old', 1000);
    turn('s2', 2, 'assistant', 'answer', 2000);
    const current = {
      id: 'live-current', role: 'interviewer', speaker: 'interviewer',
      text: 'What about this?', timestamp: 999999, finalized: false, source: 'live-transcript',
    };
    const result = getRecentConversationContext({ sessionId: 's2', currentTurn: current, recentTurnLimit: 2 });
    assert.equal(result.currentTurnIncluded, true);
    assert.equal(result.recentTranscriptWindow.at(-1)?.id, 'live-current');
  });

  test('immediate previous turns are separate from the chronological recent window', () => {
    for (let i = 1; i <= 5; i++) turn('s3', i);
    const result = getRecentConversationContext({ sessionId: 's3', immediatePreviousTurns: 2, recentTurnLimit: 5, recentWindowSeconds: 100 });
    assert.deepEqual(result.immediatePreviousTurns.map(t => t.text), ['turn 4', 'turn 3']);
    assert.deepEqual(result.recentTranscriptWindow.map(t => t.text), ['turn 1', 'turn 2', 'turn 3', 'turn 4', 'turn 5']);
  });

  test('separate sessions do not leak context', () => {
    turn('a', 1, 'interviewer', 'A only');
    turn('b', 1, 'interviewer', 'B only');
    const result = getRecentConversationContext({ sessionId: 'a', recentTurnLimit: 10, recentWindowSeconds: 100 });
    assert.deepEqual(result.recentTranscriptWindow.map(t => t.text), ['A only']);
    assert.equal(result.recentTranscriptWindow.some(t => t.text === 'B only'), false);
  });

  test('recent context does not include long-term knowledge', () => {
    turn('s4', 1);
    const result = getRecentConversationContext({ sessionId: 's4' });
    assert.equal(result.longTermKnowledgeIncluded, false);
  });

  test('older conversation remains available separately from the recent window', () => {
    for (let i = 1; i <= 20; i++) turn('s5', i);
    const result = getRecentConversationContext({
      sessionId: 's5',
      recentTurnLimit: 5,
      recentWindowSeconds: 1000,
    });
    assert.equal(result.olderConversationTurnsAvailable, 15);
    const canonical = store.getConversationState('s5');
    assert.deepEqual(canonical?.turns.slice(0, 2).map(t => t.text), ['turn 1', 'turn 2']);
  });
});
