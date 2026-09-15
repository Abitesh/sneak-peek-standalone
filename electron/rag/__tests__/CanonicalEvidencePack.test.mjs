import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NATIVELY_CANONICAL_RAG_READ = 'off';
process.env.NATIVELY_RAG_RERANK_ENABLED = 'off';

const root = path.resolve(process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const builderPath = path.join(root, 'dist-electron/electron/rag/buildRagEvidencePack.js');
const managerPath = path.join(root, 'dist-electron/electron/rag/RAGManager.js');

test('EvidencePack holds originalQuery and retrievalQuery as optional fields', () => {
  const iface = read('electron/intelligence/context-os/evidencePack.ts');
  const start = iface.indexOf('export interface EvidencePack {');
  const end = iface.indexOf('\n}', start);
  const body = iface.slice(start, end);
  assert.match(body, /originalQuery\?: string;/);
  assert.match(body, /retrievalQuery\?: string;/);
});

test('buildRagEvidencePack copies query rewrite, scores, and page/section', async () => {
  const { buildRagEvidencePack } = await import(pathToFileURL(builderPath).href);
  const pack = buildRagEvidencePack({
    originalQuery: 'What was revenue in Q3?',
    retrievalQuery: 'How did revenue in Q3 change?',
    status: 'ok',
    results: [{
      chunk: {
        id: 'c1',
        documentId: 'd1',
        text: 'Q3 revenue was 12 million',
        chunkIndex: 0,
        pageStart: 4,
        pageEnd: 4,
        section: 'Results',
        heading: 'Revenue',
        metadata: {},
      },
      score: 0.9,
      lexicalScore: 0.5,
      semanticScore: 0.8,
      rerankScore: 2,
      source: { id: 'd1', sourceType: 'mode', name: 'report.pdf', metadata: {} },
    }],
  });
  assert.equal(pack.originalQuery, 'What was revenue in Q3?');
  assert.equal(pack.retrievalQuery, 'How did revenue in Q3 change?');
  assert.equal(pack.items[0].text, 'Q3 revenue was 12 million');
  assert.equal(pack.items[0].pageStart, 4);
  assert.equal(pack.items[0].section, 'Results');
  assert.equal(pack.items[0].score.final, 0.9);
  assert.equal(pack.items[0].score.vector, 0.8);
  assert.equal(pack.answerPolicy, 'answer');
  assert.match(pack.packId, /^rag-search:pack:/);
});

test('search() returns a pack; skip-RAG refuses without inventing a second pack type', async () => {
  const { RAGManager } = await import(pathToFileURL(managerPath).href);
  const manager = Object.create(RAGManager.prototype);
  manager.queryPlanner = {
    plan(q) {
      return { retrievalQuery: q, sources: [], needsDocumentEvidence: false };
    },
  };
  manager.getSourceManagers = () => ({ modesManager: null, personalKnowledge: null });
  const skipped = await manager.search('write me a funny birthday message');
  assert.equal(skipped.status, 'no_relevant_evidence');
  assert.equal(skipped.originalQuery, 'write me a funny birthday message');
  assert.equal(skipped.retrievalQuery, 'write me a funny birthday message');
  assert.equal(skipped.pack.answerPolicy, 'refuse_insufficient_evidence');
  assert.equal(skipped.pack.items.length, 0);
  assert.equal(skipped.pack.zeroEvidenceReason, 'no_match');

  manager.queryPlanner = {
    plan() {
      return { retrievalQuery: 'Q3 revenue', sources: ['meeting'], needsDocumentEvidence: true };
    },
  };
  manager.retriever = { detectIntent: () => 'open_question' };
  manager.meetingAdapter = {
    retrieve: async () => [{
      chunk: { id: 'm1', documentId: 'm', text: 'Q3 revenue was 12 million', chunkIndex: 0, pageStart: 1, section: 'Notes', metadata: {} },
      score: 0.9,
      source: { id: 'm', sourceType: 'meeting', name: 'm.txt', metadata: {} },
    }],
  };
  manager.modeAdapter = { retrieve: async () => [] };
  manager.personalAdapter = { retrieve: async () => [] };
  manager.knowledgeAdapter = { retrieve: async () => [] };
  const found = await manager.search('What was revenue in Q3?', { selectedSources: ['meeting'], allowRerank: false });
  assert.equal(found.status, 'ok');
  assert.equal(found.originalQuery, 'What was revenue in Q3?');
  assert.equal(found.retrievalQuery, 'Q3 revenue');
  assert.equal(found.pack.originalQuery, 'What was revenue in Q3?');
  assert.equal(found.pack.retrievalQuery, 'Q3 revenue');
  assert.equal(found.pack.items[0].pageStart, 1);
  assert.equal(found.pack.items[0].section, 'Notes');
});

test('EvidenceResolver copies search queries onto the pack; Mode writers stay', () => {
  const resolver = read('electron/intelligence/context-os/EvidenceResolver.ts');
  assert.match(resolver, /function withSearchQueries\(/);
  assert.match(resolver, /originalQuery: response\?\.originalQuery/);
  assert.match(resolver, /retrievalQuery: response\?\.retrievalQuery/);
  const mode = read('electron/services/modes/ModeHybridRetriever.ts');
  assert.match(mode, /private updateIndexState\(/);
  assert.match(mode, /private removeIndexState\(/);
  assert.match(mode, /private ensureIndexTable\(/);
  assert.doesNotMatch(read('electron/rag/buildRagEvidencePack.ts'), /class .*EvidencePack/);
});
