// Change 3 — canonical structured conversation state.
// These tests prove the state store, not a formatted transcript string, owns
// turn identity, ordering, timestamps, finalization, request association and
// session isolation.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const base = path.resolve(process.cwd(), 'dist-electron/electron/context-intelligence');
const load = (name) => import(pathToFileURL(path.join(base, name)).href);

const store = await load('question/conversation-state-store.js');
const memory = await import(pathToFileURL(path.resolve(process.cwd(), 'dist-electron/electron/intelligence/ConversationMemoryService.js')).href);

const scope = (sessionId) => ({ userId: 'test-user', sessionId });

function reset() {
  store.clearConversationState();
}

function append(sessionId, text, role, timestamp, requestSequence, finalized = true) {
  return store.appendConversationTurn({
    sessionId,
    text,
    role,
    speaker: role === 'interviewer' ? 'Interviewer' : role,
    timestamp,
    finalized,
    source: role === 'interviewer' ? 'transcript' : role === 'assistant' ? 'assistant' : 'manual',
    requestSequence,
    scope: scope(sessionId),
  });
}

describe('Change 3 — canonical ConversationState', () => {
  test.afterEach(reset);

  test('1. preserves a user → assistant → user sequence as atomic turns', () => {
    const u1 = append('s1', 'What is Redis?', 'user', 1000, 1);
    const a1 = append('s1', 'Redis is an in-memory data store.', 'assistant', 1100, 1);
    const u2 = append('s1', 'Why is it fast?', 'user', 1200, 2);

    const turns = store.getRecentConversationTurns('s1', 10);
    assert.deepEqual(turns.map(t => [t.id, t.role, t.text]), [
      [u1.id, 'user', 'What is Redis?'],
      [a1.id, 'assistant', 'Redis is an in-memory data store.'],
      [u2.id, 'user', 'Why is it fast?'],
    ]);
    assert.equal(store.getCurrentConversationTurn('s1')?.id, u2.id);
  });

  test('2. preserves timestamps exactly, including interim turns', () => {
    const t1 = append('s1', 'What is Postgres?', 'interviewer', 123456789, 7, false);
    const t2 = store.updateConversationTurn({
      sessionId: 's1',
      turnId: t1.id,
      text: 'What is PostgreSQL?',
      finalized: true,
    });

    assert.equal(t2?.timestamp, 123456789);
    assert.equal(t2?.finalized, true);
    assert.equal(store.getCurrentConversationTurn('s1')?.timestamp, 123456789);
  });

  test('3. newest turn is always identifiable', () => {
    const first = append('s1', 'First', 'user', 10, 1);
    const second = append('s1', 'Second', 'assistant', 20, 1);
    const third = append('s1', 'Third', 'user', 30, 2);

    assert.equal(store.getCurrentConversationTurn('s1')?.id, third.id);
    assert.notEqual(third.id, second.id);
    assert.notEqual(third.id, first.id);
  });

  test('4. retrieving old turns does not mutate canonical state', () => {
    append('s1', 'Original question', 'user', 100, 1);
    append('s1', 'Original answer', 'assistant', 200, 1);

    const retrieved = store.getRecentConversationTurns('s1', 2);
    retrieved[0].text = 'MUTATED OUTSIDE STORE';
    if (retrieved[0].metadata) retrieved[0].metadata.changed = true;
    retrieved.push({ id: 'fake', role: 'user', speaker: 'user', text: 'fake', timestamp: 999, finalized: true, source: 'manual' });

    const again = store.getRecentConversationTurns('s1', 2);
    assert.equal(again.length, 2);
    assert.equal(again[0].text, 'Original question');
    assert.equal(again[0].metadata?.changed, undefined);
  });

  test('5. separate sessions never leak turns', () => {
    append('alice', 'Alice question', 'user', 100, 1);
    append('bob', 'Bob question', 'user', 200, 1);

    assert.deepEqual(store.getRecentConversationTurns('alice').map(t => t.text), ['Alice question']);
    assert.deepEqual(store.getRecentConversationTurns('bob').map(t => t.text), ['Bob question']);
    assert.equal(store.getCurrentConversationTurn('alice')?.text, 'Alice question');
    assert.equal(store.getCurrentConversationTurn('bob')?.text, 'Bob question');
  });

  test('6. follow-up turns retain request sequence and can read previous turns', () => {
    append('s1', 'Explain database indexes', 'user', 1000, 41);
    append('s1', 'Indexes speed up lookup by maintaining an auxiliary structure.', 'assistant', 1100, 41);
    const followUp = append('s1', 'Can you explain that more simply?', 'user', 1200, 42);

    const previous = store.getConversationWindow('s1', { seconds: 10 });
    assert.equal(previous.length, 3);
    assert.equal(previous[0].text, 'Explain database indexes');
    assert.equal(followUp.requestSequence, 42);
    assert.deepEqual(store.getConversationTurnsByRequestSequence('s1', 41).map(t => t.text), [
      'Explain database indexes',
      'Indexes speed up lookup by maintaining an auxiliary structure.',
    ]);
  });

  test('advance + answer completion create one request-associated user/assistant pair', () => {
    const state = store.advanceConversationState({
      sessionId: 's1',
      scope: scope('s1'),
      question: 'Explain database indexes',
      requestSequence: 77,
      source: 'manual-chat',
      speaker: 'user',
      timestamp: 7000,
    });
    assert.equal(state.currentRequestSequence, 77);
    assert.equal(store.getCurrentConversationTurn('s1')?.requestSequence, 77);

    store.recordAnswerSummary('s1', 'Indexes speed up database lookups.');
    const turns = store.getRecentConversationTurns('s1', 10);
    assert.deepEqual(turns.map(t => [t.role, t.requestSequence, t.text]), [
      ['user', 77, 'Explain database indexes'],
      ['assistant', 77, 'Indexes speed up database lookups.'],
    ]);
    assert.equal(store.getCurrentConversationTurn('s1')?.role, 'assistant');
  });

  test('supports bounded time windows and excludes interim turns when requested', () => {
    append('s1', 'Old', 'user', 1000, 1);
    append('s1', 'Recent interim', 'interviewer', 9000, 2, false);
    append('s1', 'Recent final', 'interviewer', 10000, 3, true);

    assert.deepEqual(
      store.getConversationWindow('s1', { seconds: 2, includeNonFinalized: false }).map(t => t.text),
      ['Recent final'],
    );
    assert.deepEqual(
      store.getConversationWindow('s1', { seconds: 2, includeNonFinalized: true }).map(t => t.text),
      ['Recent interim', 'Recent final'],
    );
  });
});

describe('Change 3 — ConversationMemoryService uses canonical state', () => {
  test.afterEach(reset);

  test('service records a Q/A pair as canonical user + assistant turns', () => {
    const svc = new memory.ConversationMemoryService();
    const stored = svc.record({
      sessionId: 'memory-s1',
      userMessage: 'Tell me about Kafka',
      assistantAnswer: 'Kafka is a distributed event streaming platform.',
      timestamp: 5000,
      mode: 'technical-interview',
    });

    const turns = store.getRecentConversationTurns('memory-s1', 10);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].role, 'user');
    assert.equal(turns[1].role, 'assistant');
    assert.equal(stored.userTurnId, turns[0].id);
    assert.equal(stored.assistantTurnId, turns[1].id);
    assert.equal(svc.getRecentTurns('memory-s1').length, 1);
  });

  test('service follow-up lookup uses the canonical records', () => {
    const svc = new memory.ConversationMemoryService();
    svc.record({ sessionId: 'memory-s2', userMessage: 'Explain Redis caching', assistantAnswer: 'Redis stores hot data in memory.', timestamp: 1 });
    svc.record({ sessionId: 'memory-s2', userMessage: 'What about Postgres?', assistantAnswer: 'Postgres is the relational database.', timestamp: 2 });

    const result = svc.resolveSameSession('memory-s2', 'can you expand on Redis?');
    assert.ok(result);
    assert.match(result.userMessage, /Redis/);
  });
});
