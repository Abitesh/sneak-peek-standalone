import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('primary manual cancellation settles the engine result after consumer closure', () => {
  const engine = read('intelligence/engine/NativelyIntelligenceEngine.ts');
  assert.match(engine, /let resultSettled = false/);
  assert.match(engine, /let preparedResult: NativelyIntelligenceResult \| null = null/);
  assert.match(engine, /finally \{[\s\S]*request\.cancellationSignal\?\.aborted[\s\S]*!resultSettled/);
  assert.match(engine, /resolveResult\(buildCancelledResult\(base, 'consumer closed an aborted generation'\)\)/);
});

test('primary manual conversation turns persist generation outcomes', () => {
  const ipc = read('ipcHandlers.ts');
  const state = read('context-intelligence/question/conversation-state.ts');
  const store = read('context-intelligence/question/conversation-state-store.ts');

  assert.match(state, /export type ConversationGenerationStatus = 'pending' \| 'completed' \| 'cancelled' \| 'failed'/);
  assert.match(state, /generationStatus\?: ConversationGenerationStatus/);
  assert.match(store, /generationStatus\?: ConversationGenerationStatus/);
  assert.match(ipc, /generationStatus: 'pending'/);
  assert.match(ipc, /generationStatus: 'cancelled'/);
  assert.match(ipc, /generationStatus: 'completed'/);
  assert.match(ipc, /generationStatus: 'failed'/);
});

test('superseded manual generations never fall through to legacy generation', () => {
  const ipc = read('ipcHandlers.ts');
  const start = ipc.indexOf('// CHANGE 13: the canonical Natively Intelligence Engine is now the PRIMARY');
  const end = ipc.indexOf('// Vision capability gate (Problem 39)', start);
  const primary = ipc.slice(start, end);

  assert.match(primary, /run\.lifecycle\.state === 'CANCELLED' \|\| myController\.signal\.aborted/);
  assert.match(primary, /generationStatus: 'cancelled'/);
  assert.match(primary, /STOP\/supersession is terminal/);
});
