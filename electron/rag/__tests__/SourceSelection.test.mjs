import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const distPath = path.join(root, 'dist-electron/electron/rag/RagQueryPlanner.js');

test('Change 31 document questions pick one family instead of fanning out', async () => {
  const { RagQueryPlanner } = await import(pathToFileURL(distPath).href);
  const planner = new RagQueryPlanner();

  const mode = planner.plan('what does the annual report say about revenue?');
  assert.deepEqual(mode.sources.filter((s) => s !== 'conversation'), ['mode-reference']);

  const knowledge = planner.plan('what does the knowledge file say about refunds?');
  assert.deepEqual(knowledge.sources.filter((s) => s !== 'conversation'), ['knowledge']);
  assert.equal(knowledge.needsDocumentEvidence, true);

  const meeting = planner.plan('what did we decide on the call?');
  assert.ok(meeting.sources.includes('meeting'));
  assert.equal(meeting.sources.includes('mode-reference'), false);
  assert.equal(meeting.sources.includes('personal-files'), false);
});

test('Change 31 default and identity questions do not fan out document families', async () => {
  const { RagQueryPlanner } = await import(pathToFileURL(distPath).href);
  const planner = new RagQueryPlanner();
  for (const q of ['who am I', 'what is the capital of France']) {
    const plan = planner.plan(q);
    assert.equal(plan.sources.includes('mode-reference'), false, q);
    assert.equal(plan.sources.includes('personal-files'), false, q);
    assert.equal(plan.sources.includes('meeting'), false, q);
    assert.equal(plan.sources.includes('knowledge'), false, q);
  }
});

test('Change 31 never selects profile or hindsight as document RAG sources', async () => {
  const { RagQueryPlanner } = await import(pathToFileURL(distPath).href);
  const planner = new RagQueryPlanner();
  for (const q of ['who am I', 'what is my name', 'remember last week', 'from long-term memory']) {
    const plan = planner.plan(q);
    assert.equal(plan.sources.includes('profile'), false, q);
    assert.equal(plan.sources.includes('hindsight'), false, q);
  }
  const plannerSrc = read('electron/rag/RagQueryPlanner.ts');
  assert.match(plannerSrc, /profile|long-term memory/);
  assert.doesNotMatch(plannerSrc, /sources\.push\('profile'\)/);
  assert.doesNotMatch(plannerSrc, /sources\.push\('hindsight'\)/);
});

test('Change 31 search has no profile or hindsight adapters', () => {
  const src = read('electron/rag/RAGManager.ts');
  const search = src.slice(src.indexOf('async search(query: string'), src.indexOf('async retrieve(query: string'));
  assert.doesNotMatch(search, /profileAdapter|hindsightAdapter|MemoryRagAdapter/);
  assert.match(search, /meetingAdapter\.retrieve|canonicalRead\.readSource/);
  assert.match(search, /modeAdapter\.retrieve|canonicalRead\.readSource/);
  assert.match(search, /personalAdapter\.retrieve|canonicalRead\.readSource/);
  assert.match(search, /knowledgeAdapter\.retrieve/);
});

test('Change 31 does not stop Mode status writers', () => {
  const mode = read('electron/services/modes/ModeHybridRetriever.ts');
  assert.match(mode, /private updateIndexState\(/);
  assert.match(mode, /private removeIndexState\(/);
  assert.match(mode, /private ensureIndexTable\(/);
});
