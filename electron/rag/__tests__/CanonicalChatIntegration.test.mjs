import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('normal chat UI talks to gemini-chat-stream, not rag:query-*', () => {
  const ui = read('src/components/NativelyInterface.tsx');
  assert.match(ui, /electronAPI\.streamGeminiChat\(/);
  assert.doesNotMatch(ui, /invoke\(['"]rag:query-/);
  const preload = read('electron/preload.ts');
  assert.match(preload, /streamGeminiChat[\s\S]{0,400}gemini-chat-stream/);
});

test('gemini-chat-stream retrieves through RAGManager, then the planner', () => {
  const ipc = read('electron/ipcHandlers.ts');
  const start = ipc.indexOf('const _geminiChatStreamHandler');
  assert.ok(start >= 0, 'gemini-chat-stream handler missing');
  const v3Port = ipc.indexOf('createRAGRetrievalPort', start);
  assert.ok(v3Port > start, 'manual chat must construct createRAGRetrievalPort');
  assert.match(ipc.slice(start, v3Port + 800), /allowedSources/);
  assert.match(ipc, /unifiedRag:\s*appState\.getRAGManager/);

  const manager = read('electron/rag/RAGManager.ts');
  const portStart = manager.indexOf('public createRAGRetrievalPort(');
  const searchStart = manager.indexOf('async search(query: string');
  assert.ok(portStart >= 0 && searchStart > portStart);
  assert.match(manager.slice(portStart, searchStart), /this\.search\(/);
  assert.match(manager.slice(searchStart, searchStart + 2500), /this\.queryPlanner\.plan\(/);
});
