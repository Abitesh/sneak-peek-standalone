// electron/rag/__tests__/Stage3PersonalFilesAnswerTime2026_09_27.test.mjs
//
// Stage 3: prove answer-time My Files / resume retrieval through RAGManager.search
// with the Stage 2 chat allowlist (allowedSources only — no selectedSources).
// Also prove the old mode-only selectedSources path cannot surface personal hits.
//
// Run: npm run build:electron && node --test electron/rag/__tests__/Stage3PersonalFilesAnswerTime2026_09_27.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NATIVELY_CANONICAL_RAG_READ = 'off';
process.env.NATIVELY_RAG_RERANK_ENABLED = 'off';
process.env.NATIVELY_RAG_DIAGNOSTICS = '1';

const root = path.resolve(process.cwd());
const managerPath = path.join(root, 'dist-electron/electron/rag/RAGManager.js');
const allowPath = path.join(root, 'dist-electron/electron/rag/universalChatAllowedSources.js');
const plannerPath = path.join(root, 'dist-electron/electron/rag/RagQueryPlanner.js');
const diagPath = path.join(root, 'dist-electron/electron/rag/RagDiagnostics.js');

const RESUME_CHUNK =
  'Built a PostgreSQL DBMS query optimizer at Acme Corp; cut p99 latency 40%.';
const NOTES_CHUNK =
  'My Files note: Redis caching + SQLite FTS5 power the personal knowledge index.';

function personalHit(id, name, text) {
  return {
    chunk: {
      id: `${id}-chunk-0`,
      documentId: id,
      text,
      chunkIndex: 0,
      metadata: { sourceType: 'personal' },
    },
    score: 0.92,
    lexicalScore: 0.9,
    source: { id, sourceType: 'personal', name, metadata: { fileType: 'resume' } },
  };
}

async function makeChatSearchManager({ personalHits = [], modeHits = [] } = {}) {
  const { RAGManager } = await import(pathToFileURL(managerPath).href);
  const { RagQueryPlanner } = await import(pathToFileURL(plannerPath).href);
  const personalCalls = [];
  const modeCalls = [];
  const manager = Object.create(RAGManager.prototype);
  manager.queryPlanner = new RagQueryPlanner();
  manager.getSourceManagers = () => ({
    modesManager: {
      getActiveModeInfo: () => ({ id: 'mode-interview' }),
      getReferenceFiles: () => [{ id: 'ref-1', fileName: 'jd.pdf' }],
    },
    personalKnowledge: {
      listFiles: () => [
        { id: 'pfile-resume', fileName: 'resume.txt' },
        { id: 'pfile-notes', fileName: 'dbms-notes.md' },
      ],
    },
  });
  manager.retriever = { detectIntent: () => 'open_question' };
  manager.embeddingPipeline = { getActiveSpaceKey: () => null };
  manager.compareCanonicalRetrievalIfEnabled = async () => {};
  // Stage 3 proves source routing → adapter → manualContext. Relevance-gate
  // calibration is out of scope; pass adapter hits through unchanged.
  manager.gateCanonicalResults = (results) => results;
  manager.meetingAdapter = { retrieve: async () => [] };
  manager.knowledgeAdapter = { retrieve: async () => [] };
  manager.modeAdapter = {
    retrieve: async (ctx) => {
      modeCalls.push(ctx.query);
      return modeHits;
    },
  };
  manager.personalAdapter = {
    retrieve: async (ctx) => {
      personalCalls.push(ctx.query);
      return personalHits;
    },
  };
  return { manager, personalCalls, modeCalls };
}

describe('Stage 3: answer-time personal-files via chat allowlist', () => {
  test('resume query → planner selects personal-files → manualContext chunk', async () => {
    const { buildUniversalChatAllowedSources } = await import(pathToFileURL(allowPath).href);
    const { buildRagDiagnosticEvent } = await import(pathToFileURL(diagPath).href);
    const { manager, personalCalls, modeCalls } = await makeChatSearchManager({
      personalHits: [personalHit('pfile-resume', 'resume.txt', RESUME_CHUNK)],
    });

    const query = 'What projects are on my resume?';
    const response = await manager.search(query, {
      allowedSources: buildUniversalChatAllowedSources(),
      allowRerank: false,
    });

    assert.equal(response.status, 'ok', `expected ok, got ${response.status}`);
    assert.ok(personalCalls.length >= 1, 'personal adapter must run');
    assert.equal(modeCalls.length, 0, 'mode adapter must not run for a personal-only plan');
    assert.ok(response.results.some((r) => r.source.sourceType === 'personal'));
    assert.ok(response.manualContext?.items?.length > 0);
    assert.match(response.manualContext.items[0].text ?? RESUME_CHUNK, /DBMS|Acme|optimizer/i);

    const diag = buildRagDiagnosticEvent({
      originalQuery: query,
      retrievalQuery: response.retrievalQuery,
      status: response.status,
      results: response.results,
      sources: ['personal-files'],
      confidence: response.confidence,
    });
    assert.equal(diag.hitCount >= 1, true);
    assert.equal(diag.hits[0].documentId, 'pfile-resume');
    assert.equal(diag.hits[0].sourceType, 'personal');
    assert.ok(diag.citationIds[0]);
    console.log('[Stage3Evidence]', JSON.stringify({
      query,
      status: response.status,
      sources: diag.sources,
      documentId: diag.hits[0].documentId,
      chunkId: diag.hits[0].chunkId,
      citationId: diag.citationIds[0],
      preview: RESUME_CHUNK.slice(0, 80),
    }));
  });

  test('My Files DBMS note query → personal-files hit with chunk text', async () => {
    const { buildUniversalChatAllowedSources } = await import(pathToFileURL(allowPath).href);
    const { manager, personalCalls } = await makeChatSearchManager({
      personalHits: [personalHit('pfile-notes', 'dbms-notes.md', NOTES_CHUNK)],
    });

    const query = 'What does my notes file say about SQLite FTS5?';
    const response = await manager.search(query, {
      allowedSources: buildUniversalChatAllowedSources(),
      allowRerank: false,
    });

    assert.equal(response.status, 'ok');
    assert.ok(personalCalls.length >= 1);
    assert.match(
      String(response.results[0]?.chunk?.text ?? ''),
      /SQLite FTS5|Redis caching/,
    );
    console.log('[Stage3Evidence]', JSON.stringify({
      query,
      status: response.status,
      documentId: response.results[0].chunk.documentId,
      chunkId: response.results[0].chunk.id,
      preview: NOTES_CHUNK.slice(0, 80),
    }));
  });

  test('legacy mode-only selectedSources cannot surface personal-files', async () => {
    const { manager, personalCalls } = await makeChatSearchManager({
      personalHits: [personalHit('pfile-resume', 'resume.txt', RESUME_CHUNK)],
    });

    const response = await manager.search('What projects are on my resume?', {
      selectedSources: ['mode-reference'],
      allowedSources: ['mode-reference'],
      allowRerank: false,
    });

    assert.equal(personalCalls.length, 0, 'mode-only exact selection must not call personal adapter');
    assert.equal(
      (response.results ?? []).some((r) => r.source?.sourceType === 'personal'),
      false,
    );
  });

  test('no-RAG chitchat still skips under chat allowlist', async () => {
    const { buildUniversalChatAllowedSources } = await import(pathToFileURL(allowPath).href);
    const { manager, personalCalls } = await makeChatSearchManager({
      personalHits: [personalHit('pfile-resume', 'resume.txt', RESUME_CHUNK)],
    });

    const response = await manager.search('write me a funny birthday message', {
      allowedSources: buildUniversalChatAllowedSources(),
      allowRerank: false,
    });

    assert.equal(response.status, 'no_relevant_evidence');
    assert.equal(personalCalls.length, 0);
  });
});
