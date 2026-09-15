import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const helperPath = path.join(root, 'dist-electron/electron/rag/resolveRagSearchSources.js');
const plannerPath = path.join(root, 'dist-electron/electron/rag/RagQueryPlanner.js');

async function load() {
  const { resolveRagSearchSources } = await import(pathToFileURL(helperPath).href);
  const { RagQueryPlanner } = await import(pathToFileURL(plannerPath).href);
  return { resolveRagSearchSources, planner: new RagQueryPlanner() };
}

const MODE_AND_KNOWLEDGE = ['mode-reference', 'knowledge'];

test('allowlist plus annual-report plan keeps mode-reference and drops knowledge', async () => {
  const { resolveRagSearchSources, planner } = await load();
  const plan = planner.plan('what does the annual report say about revenue?');
  const resolved = resolveRagSearchSources(plan, { allowedSources: MODE_AND_KNOWLEDGE });
  assert.equal(resolved.skip, false);
  assert.deepEqual(resolved.sources.filter((s) => s !== 'conversation'), ['mode-reference']);
});

test('allowlist does not disable skip for a generative birthday prompt', async () => {
  const { resolveRagSearchSources, planner } = await load();
  const plan = planner.plan('write me a funny birthday message');
  const resolved = resolveRagSearchSources(plan, { allowedSources: MODE_AND_KNOWLEDGE });
  assert.equal(plan.needsDocumentEvidence, false);
  assert.equal(resolved.skip, true);
  assert.deepEqual(resolved.sources, []);
});

test('exact selectedSources still retrieves knowledge on a birthday prompt', async () => {
  const { resolveRagSearchSources, planner } = await load();
  const plan = planner.plan('write me a funny birthday message');
  const resolved = resolveRagSearchSources(plan, { selectedSources: ['knowledge'] });
  assert.equal(resolved.skip, false);
  assert.deepEqual(resolved.sources, ['knowledge']);
});

test('allowlist without meeting drops meeting even when the plan wants it', async () => {
  const { resolveRagSearchSources, planner } = await load();
  const plan = planner.plan('what did we decide on the call?');
  assert.ok(plan.sources.includes('meeting'));
  const resolved = resolveRagSearchSources(plan, { allowedSources: MODE_AND_KNOWLEDGE });
  assert.equal(resolved.skip, false);
  assert.equal(resolved.sources.includes('meeting'), false);
});

test('forceDocumentGrounding with an empty plan falls back to the allowlist', async () => {
  const { resolveRagSearchSources } = await load();
  const resolved = resolveRagSearchSources(
    { sources: [], needsDocumentEvidence: false },
    { forceDocumentGrounding: true, allowedSources: MODE_AND_KNOWLEDGE },
  );
  assert.equal(resolved.skip, false);
  assert.deepEqual(resolved.sources, MODE_AND_KNOWLEDGE);
});

test('empty selectedSources is not an exact override', async () => {
  const { resolveRagSearchSources } = await load();
  const resolved = resolveRagSearchSources(
    { sources: [], needsDocumentEvidence: false },
    { selectedSources: [], allowedSources: MODE_AND_KNOWLEDGE },
  );
  assert.equal(resolved.skip, true);
});

test('conversation survives an allowlist that does not mention it', async () => {
  const { resolveRagSearchSources } = await load();
  const resolved = resolveRagSearchSources(
    { sources: ['meeting', 'conversation'], needsDocumentEvidence: true },
    { allowedSources: ['meeting'] },
  );
  assert.deepEqual(resolved.sources, ['meeting', 'conversation']);
});

test('search uses resolveRagSearchSources and IPC passes allowedSources', () => {
  const search = read('electron/rag/RAGManager.ts');
  const start = search.indexOf('async search(query: string');
  const end = search.indexOf('async retrieve(query: string', start);
  const body = search.slice(start, end);
  assert.match(body, /resolveRagSearchSources\(/);
  assert.match(body, /resolution\.skip/);
  assert.doesNotMatch(body, /&& !options\.selectedSources\n/);
  const port = search.slice(search.indexOf('const response = await this.search(query, {'), search.indexOf('for (const result of response.results)'));
  assert.match(port, /allowedSources:\s*options\.allowedSources/);
  assert.doesNotMatch(port, /selectedSources:\s*options\.selectedSources/);
  const ipc = read('electron/ipcHandlers.ts');
  const block = ipc.slice(ipc.indexOf('const ragSelectedSources'), ipc.indexOf('forceDocumentGrounding:'));
  assert.match(block, /allowedSources:\s*\[\.\.\.ragSelectedSources\]/);
  assert.doesNotMatch(block, /selectedSources:\s*\[\.\.\.ragSelectedSources\]/);
  assert.match(block, /ragSelectedSources\.add\('knowledge'\)/);
});

test('Change 29/31 follow-up does not stop Mode status writers', () => {
  const mode = read('electron/services/modes/ModeHybridRetriever.ts');
  assert.match(mode, /private updateIndexState\(/);
  assert.match(mode, /private removeIndexState\(/);
  assert.match(mode, /private ensureIndexTable\(/);
});
