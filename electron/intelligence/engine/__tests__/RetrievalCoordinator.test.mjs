import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const base = path.resolve(process.cwd(), 'dist-electron/electron/intelligence/engine');
const { RetrievalCoordinator, createRetrievalCapability } = await import(
  pathToFileURL(path.join(base, 'RetrievalCoordinator.js')).href,
);
const { planContext } = await import(pathToFileURL(path.join(base, 'ContextPlanner.js')).href);
const { understandTurn } = await import(
  pathToFileURL(path.join(process.cwd(), 'dist-electron/electron/context-intelligence/question/question-resolver.js')).href,
);

const permissions = {
  conversation: true, transcript: true, screen: true, mode: true,
  project: true, profile: true, files: true, memory: true, generalKnowledge: true,
};

function request(message, extra = {}) {
  return {
    requestId: 'r1', sessionId: 's1', surface: 'manual-chat', userMessage: message,
    currentTurn: { id: 't1', role: 'user', content: message }, recentConversation: [],
    contextPermissions: permissions, ...extra,
  };
}

function understanding(message) {
  return understandTurn({ manualQuestion: message, sessionId: 's1' });
}

test('general question performs no retrieval decision or capability call', async () => {
  const message = 'What is Python?';
  const req = request(message);
  const plan = planContext({ request: req, understanding: understanding(message) });
  let calls = 0;
  const coordinator = new RetrievalCoordinator({
    capabilities: [createRetrievalCapability('rag', async () => { calls += 1; return { items: [] }; })],
  });
  const result = await coordinator.retrieve(plan, req, message);
  assert.equal(result.trace.callCount, 0);
  assert.equal(calls, 0);
  assert.deepEqual(result.evidence.items, []);
});

test('project question makes exactly one intended project retrieval decision', async () => {
  const message = 'Why did you use Redis in Linkship?';
  const req = request(message, { activeContext: { projectId: 'linkship', projectName: 'Linkship' } });
  const plan = planContext({ request: req, understanding: understanding(message) });
  const calls = [];
  const coordinator = new RetrievalCoordinator({
    capabilities: [
      createRetrievalCapability('project_knowledge', async ({ source }) => {
        calls.push(source);
        return { items: [{ id: 'p1', source, content: 'Redis was used for caching.' }] };
      }),
      createRetrievalCapability('rag', async ({ source }) => {
        calls.push(source);
        return { items: [{ id: 'r1', source, content: 'duplicate generic RAG result' }] };
      }),
    ],
  });
  const result = await coordinator.retrieve(plan, req, message);
  assert.deepEqual(calls, ['project_knowledge']);
  assert.equal(result.trace.callCount, 1);
  assert.deepEqual(result.trace.executedSources, ['project_knowledge']);
  assert.equal(result.evidence.items.length, 1);
});

test('missing capability never falls back to an unrelated private source', async () => {
  const message = 'Why did you use Redis in Linkship?';
  const req = request(message, { activeContext: { projectId: 'linkship' } });
  const plan = planContext({ request: req, understanding: understanding(message) });
  let personalCalls = 0;
  const coordinator = new RetrievalCoordinator({
    capabilities: [createRetrievalCapability('personal_knowledge', async () => {
      personalCalls += 1; return { items: [] };
    })],
  });
  const result = await coordinator.retrieve(plan, req, message);
  assert.equal(result.trace.callCount, 0);
  assert.equal(personalCalls, 0);
  assert.equal(result.evidence.items.length, 0);
});

test('conversation-only recall does not call RAG', async () => {
  const message = 'What did I say earlier?';
  const req = request(message);
  const plan = planContext({ request: req, understanding: understanding(message) });
  let ragCalls = 0;
  const coordinator = new RetrievalCoordinator({
    capabilities: [createRetrievalCapability('rag', async () => { ragCalls += 1; return { items: [] }; })],
  });
  const result = await coordinator.retrieve(plan, req, message);
  assert.equal(result.trace.callCount, 0);
  assert.equal(ragCalls, 0);
});
