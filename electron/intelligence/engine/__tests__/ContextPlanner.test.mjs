import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const base = path.resolve(process.cwd(), 'dist-electron/electron/intelligence/engine');
const { planContext } = await import(pathToFileURL(path.join(base, 'ContextPlanner.js')).href);
const { understandTurn } = await import(pathToFileURL(path.join(process.cwd(), 'dist-electron/electron/context-intelligence/question/question-resolver.js')).href);

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

function request(message, extra = {}) {
  return {
    requestId: 'r1',
    sessionId: 's1',
    surface: 'manual-chat',
    userMessage: message,
    currentTurn: { id: 't1', role: 'user', content: message },
    recentConversation: [],
    contextPermissions: permissions,
    ...extra,
  };
}

function understanding(message, extra = {}) {
  return understandTurn({
    manualQuestion: message,
    sessionId: 's1',
    hasScreenContext: Boolean(extra.hasScreenContext),
    ...extra,
  });
}

function requirement(plan, source) {
  return plan.sources.find((s) => s.source === source)?.requirement;
}

test('general knowledge does not trigger project RAG or private files', () => {
  const message = 'What is Python?';
  const plan = planContext({ request: request(message), understanding: understanding(message) });

  assert.equal(plan.retrievalRequired, false);
  assert.equal(requirement(plan, 'rag'), 'not_required');
  assert.equal(requirement(plan, 'project_knowledge'), 'forbidden');
  assert.equal(requirement(plan, 'my_files'), 'forbidden');
  assert.equal(requirement(plan, 'personal_knowledge'), 'forbidden');
  assert.equal(plan.generalKnowledgeAllowed, true);
});

test('project question requires project knowledge and RAG', () => {
  const message = 'Why did you use Redis in Linkship?';
  const plan = planContext({
    request: request(message, { activeContext: { projectId: 'linkship', projectName: 'Linkship' } }),
    understanding: understanding(message),
  });

  assert.equal(requirement(plan, 'project_knowledge'), 'required');
  assert.equal(requirement(plan, 'rag'), 'required');
  assert.equal(requirement(plan, 'recent_conversation'), 'required');
  assert.equal(requirement(plan, 'personal_knowledge'), 'forbidden');
  assert.equal(plan.retrievalRequired, true);
});

test('conversation recall requires conversation retrieval, not private stores', () => {
  const message = 'What did I say earlier?';
  const plan = planContext({ request: request(message), understanding: understanding(message) });

  assert.equal(requirement(plan, 'recent_conversation'), 'required');
  assert.equal(plan.retrievalRequired, false);
  assert.equal(requirement(plan, 'project_knowledge'), 'forbidden');
  assert.equal(requirement(plan, 'my_files'), 'forbidden');
});

test('screenshot error requires screen context', () => {
  const message = 'What does this screenshot error mean?';
  const plan = planContext({
    request: request(message, { screenContext: { text: 'TypeError: cannot read property x' } }),
    understanding: understanding(message, { hasScreenContext: true }),
  });

  assert.equal(requirement(plan, 'screen'), 'required');
  assert.equal(requirement(plan, 'project_knowledge'), 'forbidden');
  assert.equal(requirement(plan, 'my_files'), 'forbidden');
});

test('tell me about yourself uses profile and personal knowledge', () => {
  const message = 'Tell me about yourself';
  const plan = planContext({
    request: request(message, { activeContext: { profileId: 'default-profile' } }),
    understanding: understanding(message),
  });

  assert.equal(requirement(plan, 'profile'), 'required');
  assert.equal(requirement(plan, 'personal_knowledge'), 'required');
  assert.equal(requirement(plan, 'project_knowledge'), 'forbidden');
  assert.equal(requirement(plan, 'my_files'), 'forbidden');
});

test('plan is exhaustive and does not treat optional context as required retrieval', () => {
  const message = 'What is a mutex?';
  const plan = planContext({ request: request(message), understanding: understanding(message) });

  assert.equal(plan.needsContext, false);
  assert.deepEqual(plan.requiredSources, []);
  assert.deepEqual(plan.optionalSources, []);
  assert.ok(plan.sources.length >= 11);
});
