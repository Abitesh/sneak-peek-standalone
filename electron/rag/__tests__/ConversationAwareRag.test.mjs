import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('Change 30 planner uses conversation-state-store, not turn memory or Hindsight', () => {
  const planner = read('electron/rag/RagQueryPlanner.ts');
  assert.match(planner, /from '\.\.\/context-intelligence\/question\/conversation-state-store'/);
  assert.match(planner, /getConversationState/);
  assert.match(planner, /resolveAgainstSession/);
  assert.match(planner, /conversationAware/);
  assert.doesNotMatch(planner, /ConversationMemoryService/);
  assert.doesNotMatch(planner, /Hindsight|LongTermMemory|long-term-memory/i);
});

test('Change 30 search loads ConversationMemoryService turns as retrieval context only', () => {
  const src = read('electron/rag/RAGManager.ts');
  const helper = src.slice(src.indexOf('private getConversationForRetrieval('), src.indexOf('private gateCanonicalResults('));
  assert.match(helper, /ConversationMemoryService\.getShared\(\)/);
  assert.match(helper, /getRecentTurns\(/);
  assert.doesNotMatch(helper, /\.recall\(/);
  const search = src.slice(src.indexOf('async search(query: string'), src.indexOf('async retrieve(query: string'));
  assert.match(search, /conversationAware:\s*isRagConversationAwareEnabled\(\)/);
  assert.match(search, /sourceSet\.has\('conversation'\) && isRagConversationAwareEnabled\(\)/);
  assert.doesNotMatch(search, /sourceType:\s*'conversation'/);
  assert.doesNotMatch(search, /conversationAdapter/);
});

test('Change 30 orchestrator advances conversation state rather than indexing it as RAG', () => {
  const orch = read('electron/context-intelligence/orchestration/orchestrator.ts');
  assert.match(orch, /advanceConversationState\(/);
  assert.doesNotMatch(orch, /new RagQueryPlanner/);
});

test('Change 30 does not stop Mode status writers', () => {
  const mode = read('electron/services/modes/ModeHybridRetriever.ts');
  assert.match(mode, /private updateIndexState\(/);
  assert.match(mode, /private removeIndexState\(/);
  assert.match(mode, /private ensureIndexTable\(/);
});
