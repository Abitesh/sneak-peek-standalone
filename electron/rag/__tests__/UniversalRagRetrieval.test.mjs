import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const distPath = path.join(root, 'dist-electron/electron/rag/dedupeRagSearchResults.js');

function hit(id, score, extra = {}) {
  return {
    chunk: { id, documentId: `doc-${id}`, text: extra.text ?? `text-${id}`, chunkIndex: extra.chunkIndex ?? 0, metadata: {} },
    score,
    lexicalScore: extra.lexicalScore,
    semanticScore: extra.semanticScore,
    source: { id: extra.sourceId ?? `src-${id}`, sourceType: extra.sourceType ?? 'meeting', name: 'n', metadata: {} },
  };
}

test('dedupeRagSearchResults keeps first-seen order, higher score, and merged lexical/semantic fields', async () => {
  const { dedupeRagSearchResults } = await import(pathToFileURL(distPath).href);
  const a = hit('c1', 0.4, { lexicalScore: 0.4, sourceType: 'meeting' });
  const b = hit('c2', 0.7, { sourceType: 'mode' });
  const aBetter = hit('c1', 0.9, { semanticScore: 0.9, sourceType: 'personal' });
  const out = dedupeRagSearchResults([a, b, aBetter]);
  assert.equal(out.length, 2);
  assert.equal(out[0].chunk.id, 'c1');
  assert.equal(out[0].score, 0.9);
  assert.equal(out[0].lexicalScore, 0.4);
  assert.equal(out[0].semanticScore, 0.9);
  assert.equal(out[1].chunk.id, 'c2');
  assert.equal(a.score, 0.4, 'input must not be mutated');
});

test('dedupeRagSearchResults keeps id-less hits and does not invent RRF scores', async () => {
  const { dedupeRagSearchResults } = await import(pathToFileURL(distPath).href);
  const nameless = hit('', 0.2, { text: 'x' });
  nameless.chunk.id = '';
  const alsoNameless = hit('', 0.3, { text: 'y' });
  alsoNameless.chunk.id = '';
  const out = dedupeRagSearchResults([nameless, alsoNameless, hit('c1', 0.5)]);
  assert.equal(out.length, 3);
  assert.equal(out.some((row) => row.rrfScore != null), false);
});

test('RAGManager.search is the universal engine: plan → sources → dedupe → rerank → gate, no second pipeline', () => {
  const src = read('electron/rag/RAGManager.ts');
  const start = src.indexOf('async search(query: string');
  const end = src.indexOf('async retrieve(query: string', start);
  assert.ok(start >= 0 && end > start, 'search() must exist before retrieve()');
  const search = src.slice(start, end);
  const planAt = search.indexOf('this.queryPlanner.plan(');
  const dedupeAt = search.indexOf('dedupeRagSearchResults(');
  const rerankAt = search.indexOf('rerankCanonicalResults(');
  const gateAt = search.indexOf('gateCanonicalResults(');
  assert.ok(planAt >= 0, 'query prep / source selection via RagQueryPlanner');
  assert.ok(dedupeAt > planAt, 'cross-source dedupe after source concat');
  assert.ok(rerankAt > dedupeAt, 'rerank after dedupe so duplicate chunks do not consume the pool');
  assert.ok(gateAt > rerankAt, 'relevance gate is the last stage before return');
  assert.match(search, /meetingAdapter\.retrieve|canonicalRead\.readSource/);
  assert.match(search, /modeAdapter\.retrieve|canonicalRead\.readSource/);
  assert.match(search, /personalAdapter\.retrieve|canonicalRead\.readSource/);
  assert.match(search, /knowledgeAdapter\.retrieve/);
  assert.doesNotMatch(src, /class UniversalRagEngine/);
  assert.doesNotMatch(search, /reciprocalRank|rrfScore/);
});

test('Change 28 does not stop Mode status writers', () => {
  const mode = read('electron/services/modes/ModeHybridRetriever.ts');
  assert.match(mode, /private updateIndexState\(/);
  assert.match(mode, /private removeIndexState\(/);
  assert.match(mode, /private ensureIndexTable\(/);
});
