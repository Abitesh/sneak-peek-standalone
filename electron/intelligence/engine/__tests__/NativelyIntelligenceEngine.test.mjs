import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const base = path.resolve(process.cwd(), 'dist-electron/electron/intelligence/engine');
const { NativelyIntelligenceEngine } = await import(
  pathToFileURL(path.join(base, 'NativelyIntelligenceEngine.js')).href,
);

const permissions = {
  conversation: true,
  transcript: true,
  screen: true,
  mode: true,
  project: true,
  profile: true,
  files: true,
  memory: true,
  generalKnowledge: true,
};

describe('NativelyIntelligenceEngine contract', () => {
  test('accepts a complete request and produces a provider-independent decision', async () => {
    const engine = new NativelyIntelligenceEngine();
    const result = await engine.handle({
      requestId: 'req-1',
      sessionId: 'session-1',
      surface: 'manual-chat',
      userMessage: 'What is a mutex?',
      currentTurn: { id: 'turn-1', role: 'user', content: 'What is a mutex?' },
      recentConversation: [],
      contextPermissions: permissions,
    });

    assert.equal(result.requestId, 'req-1');
    assert.equal(result.resolvedQuestion, 'What is a mutex?');
    assert.equal(result.intent, 'general-question');
    assert.equal(result.responseType, 'answer');
    assert.equal(result.providerAttempt.status, 'not-started');
    assert.equal(result.streamLifecycle.status, 'not-started');
    assert.equal(result.finalAnswer, null);
    assert.ok(result.diagnostics.stages.includes('understand'));
    assert.ok(result.diagnostics.stages.includes('plan-context'));
  });

  test('represents cancellation without requiring a provider', async () => {
    const controller = new AbortController();
    controller.abort();
    const engine = new NativelyIntelligenceEngine();

    const result = await engine.handle({
        requestId: 'req-cancelled',
        sessionId: 'session-1',
        surface: 'manual-chat',
        userMessage: 'Explain cancellation.',
        currentTurn: { id: 'turn-2', role: 'user', content: 'Explain cancellation.' },
        recentConversation: [],
        cancellationSignal: controller.signal,
        contextPermissions: permissions,
      });

    assert.equal(result.providerAttempt.status, 'cancelled');
    assert.equal(result.streamLifecycle.status, 'cancelled');
    assert.equal(result.finalAnswer, null);
    assert.match(result.diagnostics.warnings[0], /cancelled/i);
  });

  test('uses the canonical context planner to block private retrieval for general questions', async () => {
    const engine = new NativelyIntelligenceEngine();
    const result = await engine.handle({
      requestId: 'req-general-context',
      sessionId: 'session-1',
      surface: 'manual-chat',
      userMessage: 'What is Python?',
      currentTurn: { id: 'turn-3', role: 'user', content: 'What is Python?' },
      recentConversation: [],
      activeContext: { projectId: 'linkship', projectName: 'Linkship' },
      contextPermissions: permissions,
    });

    assert.equal(result.contextPlan.retrievalRequired, false);
    assert.equal(result.contextPlan.forbiddenSources.includes('project_knowledge'), true);
    assert.equal(result.contextPlan.forbiddenSources.includes('my_files'), true);
    assert.equal(result.retrievalPlan.shouldRetrieve, false);
  });

  test('uses the canonical context planner for a project-specific question', async () => {
    const engine = new NativelyIntelligenceEngine();
    const result = await engine.handle({
      requestId: 'req-project-context',
      sessionId: 'session-1',
      surface: 'manual-chat',
      userMessage: 'Why did you use Redis in Linkship?',
      currentTurn: { id: 'turn-4', role: 'user', content: 'Why did you use Redis in Linkship?' },
      recentConversation: [],
      activeContext: { projectId: 'linkship', projectName: 'Linkship' },
      contextPermissions: permissions,
    });

    assert.equal(result.contextPlan.retrievalRequired, true);
    assert.equal(result.contextPlan.requiredSources.includes('project_knowledge'), true);
    assert.equal(result.contextPlan.requiredSources.includes('rag'), true);
    assert.equal(result.retrievalPlan.shouldRetrieve, true);
    assert.deepEqual(result.retrievalPlan.sources, ['rag']);
  });

});
