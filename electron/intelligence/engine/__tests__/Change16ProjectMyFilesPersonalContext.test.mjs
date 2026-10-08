import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const base = path.resolve(process.cwd(), 'dist-electron/electron/intelligence/engine');
const { planContext } = await import(pathToFileURL(path.join(base, 'ContextPlanner.js')).href);
const { RetrievalCoordinator, createRetrievalCapability } = await import(
  pathToFileURL(path.join(base, 'RetrievalCoordinator.js')).href,
);
const { understandTurn } = await import(
  pathToFileURL(path.join(process.cwd(), 'dist-electron/electron/context-intelligence/question/question-resolver.js')).href,
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

function request(message, extra = {}) {
  return {
    requestId: 'change16-request',
    sessionId: 'change16-session',
    surface: 'manual-chat',
    userMessage: message,
    currentTurn: { id: 'turn', role: 'user', content: message },
    recentConversation: [],
    contextPermissions: { ...permissions },
    ...extra,
  };
}

function understanding(message) {
  return understandTurn({ manualQuestion: message, sessionId: 'change16-session' });
}

test('project question retrieves project evidence even without a projectId field', async () => {
  const message = 'Why did you use Redis in Linkship?';
  const req = request(message);
  const plan = planContext({ request: req, understanding: understanding(message) });
  assert.ok(plan.requiredSources.includes('project_knowledge'));
  assert.ok(plan.forbiddenSources.includes('profile'));
  assert.ok(plan.forbiddenSources.includes('personal_knowledge'));

  const calls = [];
  const coordinator = new RetrievalCoordinator({
    capabilities: [
      createRetrievalCapability('project_knowledge', async ({ source }) => {
        calls.push(source);
        return { items: [{ id: 'linkship-redis', source, content: 'Linkship uses Redis for caching and rate limiting.' }] };
      }),
      createRetrievalCapability('profile', async ({ source }) => {
        calls.push(source);
        return { items: [{ id: 'profile-redis', source, content: 'The user has used Redis before.' }] };
      }),
      createRetrievalCapability('personal_knowledge', async ({ source }) => {
        calls.push(source);
        return { items: [{ id: 'personal-redis', source, content: 'Personal Redis note.' }] };
      }),
    ],
  });
  const result = await coordinator.retrieve(plan, req, message);
  assert.deepEqual(calls, ['project_knowledge']);
  assert.deepEqual(result.trace.executedSources, ['project_knowledge']);
  assert.equal(result.evidence.items[0].id, 'linkship-redis');
});

test('general question never reaches project, My Files, or profile retrieval', async () => {
  const message = 'What is Django?';
  const req = request(message, { activeContext: { projectId: 'linkship', profileId: 'local-profile' } });
  const plan = planContext({ request: req, understanding: understanding(message) });
  assert.equal(plan.requiredSources.length, 0);
  assert.ok(plan.forbiddenSources.includes('project_knowledge'));
  assert.ok(plan.forbiddenSources.includes('my_files'));
  assert.ok(plan.forbiddenSources.includes('profile'));

  let calls = 0;
  const coordinator = new RetrievalCoordinator({
    capabilities: ['project_knowledge', 'my_files', 'profile'].map((source) => createRetrievalCapability(source, async () => {
      calls += 1;
      return { items: [] };
    })),
  });
  await coordinator.retrieve(plan, req, message);
  assert.equal(calls, 0);
});

test('My Files question selects only the file source, not project or profile sources', async () => {
  const message = 'What does this uploaded document say about the API?';
  const req = request(message);
  const plan = planContext({ request: req, understanding: understanding(message) });
  assert.deepEqual(new Set(plan.requiredSources), new Set(['my_files', 'rag']));
  assert.ok(plan.forbiddenSources.includes('project_knowledge'));
  assert.ok(plan.forbiddenSources.includes('profile'));

  const calls = [];
  const coordinator = new RetrievalCoordinator({
    capabilities: [
      createRetrievalCapability('my_files', async ({ source }) => {
        calls.push(source);
        return { items: [{ id: 'uploaded-api', source, content: 'The uploaded document uses JWT authentication.' }] };
      }),
      createRetrievalCapability('project_knowledge', async ({ source }) => {
        calls.push(source);
        return { items: [{ id: 'project-api', source, content: 'Project API detail.' }] };
      }),
      createRetrievalCapability('profile', async ({ source }) => {
        calls.push(source);
        return { items: [{ id: 'profile-api', source, content: 'Profile API detail.' }] };
      }),
    ],
  });
  const result = await coordinator.retrieve(plan, req, message);
  assert.deepEqual(calls, ['my_files']);
  assert.equal(result.evidence.items[0].id, 'uploaded-api');
});

test('permission denial prevents a private capability from executing', async () => {
  const message = 'Why did you use Redis in Linkship?';
  const req = request(message, { contextPermissions: { ...permissions, project: false } });
  const plan = planContext({ request: req, understanding: understanding(message) });
  assert.ok(plan.requiredSources.includes('project_knowledge'));

  let calls = 0;
  const coordinator = new RetrievalCoordinator({
    capabilities: [createRetrievalCapability('project_knowledge', async () => {
      calls += 1;
      return { items: [{ id: 'must-not-run', source: 'project_knowledge', content: 'private project evidence' }] };
    })],
  });
  const result = await coordinator.retrieve(plan, req, message);
  assert.equal(calls, 0);
  assert.deepEqual(result.evidence.items, []);
  assert.ok(result.trace.skippedSources.includes('project_knowledge'));
});

test('project authority wins when a turn is explicitly marked as both project and personal', async () => {
  const message = 'Why did I use Redis in Linkship?';
  const req = request(message);
  const baseUnderstanding = understanding(message);
  const mixedUnderstanding = {
    ...baseUnderstanding,
    requiresPersonalContext: true,
    requiresProjectContext: true,
  };
  const plan = planContext({ request: req, understanding: mixedUnderstanding });
  assert.ok(plan.requiredSources.includes('project_knowledge'));
  assert.ok(plan.forbiddenSources.includes('profile'));
  assert.ok(plan.forbiddenSources.includes('personal_knowledge'));
  assert.ok(plan.forbiddenSources.includes('structured_knowledge'));
});
