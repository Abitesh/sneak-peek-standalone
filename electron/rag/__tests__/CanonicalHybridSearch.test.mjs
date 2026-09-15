import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('Change 32 canonical merge reuses fuseRanked behind ragRrfFusion default off', () => {
  const src = read('electron/rag/canonical/CanonicalRagReadService.ts');
  assert.match(src, /from '\.\.\/\.\.\/intelligence\/RrfFusion'/);
  assert.match(src, /fuseRanked\(/);
  assert.match(src, /isRagRrfFusionEnabled\(/);
  assert.doesNotMatch(src, /function reciprocalRank|DEFAULT_RRF_K\s*=/);
  const flags = read('electron/intelligence/intelligenceFlags.ts');
  assert.match(flags, /ragRrfFusion: \{ env: 'NATIVELY_RAG_RRF_FUSION'[\s\S]*default: false \}/);
});

test('Change 32 does not put RRF on RAGManager.search or enable the flag', () => {
  const src = read('electron/rag/RAGManager.ts');
  const search = src.slice(src.indexOf('async search(query: string'), src.indexOf('async retrieve(query: string'));
  assert.match(search, /dedupeRagSearchResults\(/);
  assert.doesNotMatch(search, /fuseRanked|reciprocalRank|rrfScore/);
  assert.doesNotMatch(search, /isRagRrfFusionEnabled\(/);
});

test('Change 32 does not stop Mode status writers', () => {
  const mode = read('electron/services/modes/ModeHybridRetriever.ts');
  assert.match(mode, /private updateIndexState\(/);
  assert.match(mode, /private removeIndexState\(/);
  assert.match(mode, /private ensureIndexTable\(/);
});
