import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NATIVELY_SEMANTIC_ADMISSION_GATE = 'on';
process.env.NATIVELY_RAG_RERANK_ENABLED = 'off';
process.env.NATIVELY_CANONICAL_RAG_READ = 'off';

const root = path.resolve(process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const helperPath = path.join(root, 'dist-electron/electron/rag/admitCanonicalRagHit.js');
const managerPath = path.join(root, 'dist-electron/electron/rag/RAGManager.js');
const GEMINI = 'gemini:gemini-embedding-2:768';

async function loadAdmit() {
  return import(pathToFileURL(helperPath).href);
}

test('weak final scores fail the existing MIN_ANSWER_CONFIDENCE floor', async () => {
  const { admitCanonicalRagHit } = await loadAdmit();
  assert.equal(admitCanonicalRagHit({ score: 0.1 }), false);
  assert.equal(admitCanonicalRagHit({ score: 0.31 }), false);
  assert.equal(admitCanonicalRagHit({ score: 0.32 }), true);
  assert.equal(admitCanonicalRagHit({ score: 0.9 }), true);
});

test('semanticAdmissionGate drops uncalibrated vector hits unless Mode lexical rescue or BGE applied', async () => {
  const { admitCanonicalRagHit } = await loadAdmit();
  assert.equal(admitCanonicalRagHit({ score: 0.9, semanticScore: 0.4 }, GEMINI), false);
  assert.equal(admitCanonicalRagHit({ score: 0.9, semanticScore: 0.4, lexicalScore: 0.06 }, GEMINI), true);
  assert.equal(admitCanonicalRagHit({ score: 0.9, semanticScore: 0.4, rerankScore: 1.2 }, GEMINI), true);
  assert.equal(admitCanonicalRagHit({ score: 0.9, semanticScore: 0.72 }, GEMINI), true);
  assert.equal(admitCanonicalRagHit({ score: 0.9, semanticScore: 0.4 }, 'unknown-space'), true);
});

test('search() gates with admitCanonicalRagHit and existing sufficiency; Mode writers stay', () => {
  const src = read('electron/rag/RAGManager.ts');
  const start = src.indexOf('private gateCanonicalResults(');
  const end = src.indexOf('public createRAGRetrievalPort(');
  const gate = src.slice(start, end);
  assert.match(gate, /admitCanonicalRagHit\(/);
  assert.match(gate, /evaluateRagRelevanceGate\(/);
  assert.match(gate, /MIN_ANSWER_CONFIDENCE|isRagConfidenceGateEnabled/);
  assert.match(read('electron/rag/admitCanonicalRagHit.ts'), /MIN_ANSWER_CONFIDENCE/);
  assert.match(read('electron/rag/admitCanonicalRagHit.ts'), /resolveSemanticFloor/);
  assert.doesNotMatch(read('electron/rag/admitCanonicalRagHit.ts'), /0\.55|NEW_THRESHOLD|FABRICAT/);
  const mode = read('electron/services/modes/ModeHybridRetriever.ts');
  assert.match(mode, /private updateIndexState\(/);
  assert.match(mode, /private removeIndexState\(/);
  assert.match(mode, /private ensureIndexTable\(/);
});

test('search() returns no_relevant_evidence for weak-only hits and keeps a strong question match', async () => {
  const { RAGManager } = await import(pathToFileURL(managerPath).href);
  const make = (rows) => {
    const manager = Object.create(RAGManager.prototype);
    manager.queryPlanner = {
      plan() {
        return { retrievalQuery: 'project update', sources: ['meeting'], needsDocumentEvidence: true };
      },
    };
    manager.getSourceManagers = () => ({ modesManager: null, personalKnowledge: null });
    manager.embeddingPipeline = { getActiveSpaceKey: () => GEMINI };
    manager.retriever = { detectIntent: () => 'open_question' };
    manager.meetingAdapter = { retrieve: async () => rows };
    manager.modeAdapter = { retrieve: async () => [] };
    manager.personalAdapter = { retrieve: async () => [] };
    manager.knowledgeAdapter = { retrieve: async () => [] };
    return manager;
  };
  const hit = (id, score, extra = {}) => ({
    chunk: { id, documentId: 'm', text: extra.text ?? 'project update notes', chunkIndex: 0, metadata: {} },
    score,
    semanticScore: extra.semanticScore,
    lexicalScore: extra.lexicalScore,
    rerankScore: extra.rerankScore,
    source: { id: 'm', sourceType: 'meeting', name: 'm.txt', metadata: {} },
  });

  const weak = await make([hit('weak', 0.1)]).search('project update', {
    selectedSources: ['meeting'],
    allowRerank: false,
  });
  assert.equal(weak.status, 'no_relevant_evidence');
  assert.equal(weak.results.length, 0);

  const strong = await make([hit('strong', 0.9)]).search('project update', {
    selectedSources: ['meeting'],
    allowRerank: false,
  });
  assert.equal(strong.status, 'ok');
  assert.equal(strong.results[0].chunk.id, 'strong');
});
