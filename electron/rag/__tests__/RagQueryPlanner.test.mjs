import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const distPath = path.join(root, 'dist-electron/electron/rag/RagQueryPlanner.js');

async function loadPlanner() {
  return import(pathToFileURL(distPath).href);
}

test('Change 29 skips document RAG for generative prompts like a funny birthday message', async () => {
  const { RagQueryPlanner } = await loadPlanner();
  const planner = new RagQueryPlanner();
  const plan = planner.plan('write me a funny birthday message');
  assert.equal(plan.needsDocumentEvidence, false);
  assert.equal(plan.retrievalMode, 'skip');
  assert.deepEqual(plan.sources, []);
  assert.equal(plan.originalQuery, 'write me a funny birthday message');
  assert.equal(plan.retrievalQuery, 'write me a funny birthday message');
});

test('Change 29 retrieves for meeting, personal, and document questions', async () => {
  const { RagQueryPlanner } = await loadPlanner();
  const planner = new RagQueryPlanner();

  const meeting = planner.plan('what did we decide on the call?');
  assert.equal(meeting.needsDocumentEvidence, true);
  assert.equal(meeting.retrievalMode, 'retrieve');
  assert.ok(meeting.sources.includes('meeting'));

  const personal = planner.plan('find my resume');
  assert.equal(personal.needsDocumentEvidence, true);
  assert.ok(personal.sources.includes('personal-files'));

  const mode = planner.plan('what does the annual report say about revenue?');
  assert.equal(mode.needsDocumentEvidence, true);
  assert.ok(mode.sources.includes('mode-reference'));
});

test('Change 29 follow-up stubs still retrieve when the prior turn was a document question', async () => {
  const { RagQueryPlanner } = await loadPlanner();
  const storePath = path.join(root, 'dist-electron/electron/context-intelligence/question/conversation-state-store.js');
  const { advanceConversationState } = await import(pathToFileURL(storePath).href);
  const sessionId = 'c29-elaborate-follow-up';
  advanceConversationState({
    sessionId,
    scope: { userId: 'u1', sessionId },
    question: 'what did we decide on the call?',
  });
  const plan = new RagQueryPlanner().plan('elaborate', sessionId);
  assert.equal(plan.needsDocumentEvidence, true);
  assert.equal(plan.retrievalMode, 'retrieve');
  assert.ok(plan.sources.includes('meeting'));
});

test('Change 29 does not skip when a generative verb is about a meeting or file', async () => {
  const { RagQueryPlanner } = await loadPlanner();
  const planner = new RagQueryPlanner();
  const plan = planner.plan('write a summary of today\'s meeting');
  assert.equal(plan.needsDocumentEvidence, true);
  assert.equal(plan.retrievalMode, 'retrieve');
  assert.ok(plan.sources.includes('meeting'));
});

test('simple general technical questions skip document retrieval even when files exist', async () => {
  const { RagQueryPlanner } = await loadPlanner();
  const plan = new RagQueryPlanner().plan('What is DBMS?', undefined, {
    hasPersonalFiles: true,
    hasProjectFiles: true,
    hasModeReferenceFiles: true,
    projectFileNames: ['Linkship-architecture.pdf'],
  });
  assert.equal(plan.needsDocumentEvidence, false);
  assert.equal(plan.retrievalMode, 'skip');
  assert.deepEqual(plan.sources, []);
});

test('a named project file routes project questions to project-tagged My Files only', async () => {
  const { RagQueryPlanner } = await loadPlanner();
  const context = {
    hasPersonalFiles: true,
    hasProjectFiles: true,
    hasModeReferenceFiles: true,
    projectFileNames: ['Linkship-architecture.pdf'],
  };
  const planner = new RagQueryPlanner();

  for (const question of ['Explain Linkship', 'Tell me about Linkship', 'What is Linkship?']) {
    const plan = planner.plan(question, undefined, context);
    assert.equal(plan.needsDocumentEvidence, true, question);
    assert.deepEqual(plan.sources, ['personal-files']);
    assert.equal(plan.projectFilesOnly, true);
  }

  const motivation = planner.plan('Why did we use PostGIS?', undefined, context);
  assert.deepEqual(motivation.sources, ['personal-files']);
  assert.equal(motivation.projectFilesOnly, true);
});

test('Change 29 search honors skip unless the caller forces grounding or sources', () => {
  const src = read('electron/rag/RAGManager.ts');
  const start = src.indexOf('async search(query: string');
  const end = src.indexOf('async retrieve(query: string', start);
  const search = src.slice(start, end);
  assert.match(search, /resolveRagSearchSources\(/);
  assert.match(search, /resolution\.skip/);
  assert.ok(
    search.indexOf('resolution.skip') < search.indexOf('meetingAdapter.retrieve'),
    'skip must happen before source adapters run',
  );
});

test('Change 29 does not stop Mode status writers or invent a second planner', () => {
  const mode = read('electron/services/modes/ModeHybridRetriever.ts');
  assert.match(mode, /private updateIndexState\(/);
  assert.match(mode, /private removeIndexState\(/);
  assert.match(mode, /private ensureIndexTable\(/);
  const planner = read('electron/rag/RagQueryPlanner.ts');
  assert.doesNotMatch(planner, /class SecondRagQueryPlanner|class LocalPrivateRagPipeline/);
});
