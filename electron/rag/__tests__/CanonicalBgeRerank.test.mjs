import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NATIVELY_CANONICAL_RAG_READ = 'off';
process.env.NATIVELY_RAG_RERANK_ENABLED = 'on';
process.env.NATIVELY_RAG_LOCAL_RERANK = 'on';

const root = path.resolve(process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const helperPath = path.join(root, 'dist-electron/electron/rag/resolveCanonicalRerankLimits.js');
const managerPath = path.join(root, 'dist-electron/electron/rag/RAGManager.js');

async function loadLimits() {
  return import(pathToFileURL(helperPath).href);
}

const { RAGManager } = await import(pathToFileURL(managerPath).href);

function hits(count, sourceType = 'meeting') {
  return Array.from({ length: count }, (_, i) => ({
    chunk: {
      id: `${sourceType}-${i}`,
      documentId: `${sourceType}-doc`,
      text: `chunk-${i} project update`,
      chunkIndex: i,
      metadata: {},
    },
    score: (count - i) / count,
    source: { id: `${sourceType}-doc`, sourceType, name: `${sourceType}.txt`, metadata: {} },
  }));
}

function makeSearchHarness(retrieve) {
  const manager = Object.create(RAGManager.prototype);
  manager.queryPlanner = {
    plan() {
      return { retrievalQuery: 'project update', sources: ['meeting'], needsDocumentEvidence: true };
    },
  };
  manager.getSourceManagers = () => ({ modesManager: null, personalKnowledge: null });
  manager.meetingAdapter = { retrieve };
  manager.modeAdapter = { retrieve: async () => [] };
  manager.personalAdapter = { retrieve: async () => [] };
  manager.knowledgeAdapter = { retrieve: async () => [] };
  manager.gateCanonicalResults = (results) => results;
  return manager;
}

test('default BGE pool is 50, not always 100; clamp is 50–100 and top-K is 5–15', async () => {
  const { resolveCanonicalRerankLimits } = await loadLimits();
  assert.deepEqual(resolveCanonicalRerankLimits({ rerankActive: true }), {
    topK: 8,
    candidatePoolSize: 50,
    rerankCandidatePoolSize: 50,
  });
  assert.equal(resolveCanonicalRerankLimits({ rerankActive: true, rerankCandidatePoolSize: 80 }).rerankCandidatePoolSize, 80);
  assert.equal(resolveCanonicalRerankLimits({ rerankActive: true, rerankCandidatePoolSize: 200 }).rerankCandidatePoolSize, 100);
  assert.equal(resolveCanonicalRerankLimits({ rerankActive: true, topK: 20, candidatePoolSize: 20 }).topK, 15);
  assert.equal(resolveCanonicalRerankLimits({ rerankActive: true, topK: 20, candidatePoolSize: 20 }).candidatePoolSize, 50);
  assert.equal(resolveCanonicalRerankLimits({ rerankActive: true, topK: 3 }).topK, 3);
});

test('rerank-off keeps the pre-Change-33 20-candidate / top-20 V3 and 50-OKF cuts', async () => {
  const { resolveCanonicalRerankLimits } = await loadLimits();
  const v3 = resolveCanonicalRerankLimits({ rerankActive: false, topK: 20, candidatePoolSize: 20 });
  assert.deepEqual(v3, { topK: 20, candidatePoolSize: 20, rerankCandidatePoolSize: 20 });
  const okf = resolveCanonicalRerankLimits({ rerankActive: false, topK: 50, candidatePoolSize: 12 });
  assert.equal(okf.topK, 50);
  assert.equal(okf.candidatePoolSize, 50);
});

test('search() uses LocalReranker after dedupe and does not invent a second reranker', () => {
  const src = read('electron/rag/RAGManager.ts');
  const start = src.indexOf('async search(query: string');
  const end = src.indexOf('async retrieve(query: string', start);
  const search = src.slice(start, end);
  assert.match(search, /resolveCanonicalRerankLimits\(/);
  assert.match(search, /rerankCanonicalResults\(/);
  assert.match(src, /getLocalReranker\(\)/);
  assert.match(src, /const batchSize = 6/);
  assert.doesNotMatch(src, /class (Canonical|Bge|New)Reranker/);
  assert.doesNotMatch(search, /queryMeeting\(|queryGlobal\(/);
});

test('source adapters still leave BGE to the manager; Mode writers stay', () => {
  assert.match(read('electron/rag/adapters/ModeRagAdapter.ts'), /allowRerank:\s*false/);
  assert.match(read('electron/rag/adapters/MeetingRagAdapter.ts'), /allowRerank:\s*false/);
  const mode = read('electron/services/modes/ModeHybridRetriever.ts');
  assert.match(mode, /private updateIndexState\(/);
  assert.match(mode, /private removeIndexState\(/);
  assert.match(mode, /private ensureIndexTable\(/);
  assert.match(read('electron/rag/localRerankerWorker.ts'), /msg\.type === 'rerank'/);
});

test('BGE path retrieves 50–100, reorders, and keeps at most 15', async () => {
  let requestedPool = 0;
  let rerankPool = 0;
  const manager = makeSearchHarness(async (context) => {
    requestedPool = context.candidatePoolSize;
    return hits(20);
  });
  manager.rerankCanonicalResults = async (_query, results, poolSize) => {
    rerankPool = poolSize;
    const pool = results.slice(0, Math.min(poolSize, results.length));
    const last = pool[pool.length - 1];
    return [{ ...last, rerankScore: 8, score: 2 }, ...results.filter((row) => row.chunk.id !== last.chunk.id)];
  };
  const response = await manager.search('project update', {
    selectedSources: ['meeting'],
    topK: 20,
    candidatePoolSize: 20,
    allowRerank: true,
  });
  assert.equal(requestedPool, 50);
  assert.equal(rerankPool, 50);
  assert.equal(response.results.length, 15);
  assert.equal(response.results[0].chunk.id, 'meeting-19');
  assert.equal(response.results[0].rerankScore, 8);
});

test('allowRerank false does not inflate the V3 20-candidate pool or call BGE', async () => {
  let requestedPool = 0;
  let reranked = false;
  const manager = makeSearchHarness(async (context) => {
    requestedPool = context.candidatePoolSize;
    return hits(20);
  });
  manager.rerankCanonicalResults = async () => {
    reranked = true;
    return [];
  };
  const response = await manager.search('project update', {
    selectedSources: ['meeting'],
    topK: 20,
    candidatePoolSize: 20,
    allowRerank: false,
  });
  assert.equal(reranked, false);
  assert.equal(requestedPool, 20);
  assert.equal(response.results.length, 20);
  assert.equal(response.results[0].chunk.id, 'meeting-0');
});
