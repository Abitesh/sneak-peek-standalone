import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CanonicalRagShadowService } from '../../../dist-electron/electron/rag/canonical/CanonicalRagShadowService.js';
import { CanonicalRagStorage } from '../../../dist-electron/electron/rag/canonical/CanonicalRagStorage.js';
import { installCanonicalRagSchema } from '../../../dist-electron/electron/rag/canonical/CanonicalRagSchema.js';
import { ModeContextRetriever } from '../../../dist-electron/electron/services/ModeContextRetriever.js';
import { ModesManager } from '../../../dist-electron/electron/services/ModesManager.js';

const root = process.cwd();

function source(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function makeCanonicalDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  installCanonicalRagSchema(db);
  return db;
}

function seedReadyMeeting(storage, meetingId) {
  const doc = storage.createDocument({ sourceType: 'meeting', sourceId: meetingId, name: `Meeting ${meetingId}` });
  const revision = storage.createRevision({
    documentId: doc.id,
    contentHash: `hash-${meetingId}`,
    extractionVersion: 'legacy-unknown',
    chunkingVersion: 'legacy-unknown',
    normalizationVersion: 'legacy-unknown',
  });
  storage.replaceChunks(doc.id, revision.id, [{
    chunkIndex: 0,
    text: 'canonical meeting project update',
    sourceLocator: 'meeting:0',
  }]);
  // replaceChunks() already advances a fresh revision through
  // NOT_INDEXED -> QUEUED -> EXTRACTING -> CHUNKING -> LEXICAL_READY.
  // Only the final READY transition is needed here.
  storage.setStatus(doc.id, revision.id, 'READY', { chunkCount: 1 });
  storage.activateRevision(doc.id, revision.id);
  return { doc, revision };
}

describe('Change 25 Phase 6.4 canonical shadow boundaries', () => {
  test('queryMeeting and queryGlobal observe the canonical shadow through search without replacing results', () => {
    const src = source('electron/rag/RAGManager.ts');

    const meeting = src.indexOf('async *queryMeeting(');
    const global = src.indexOf('async *queryGlobal(');
    const search = src.indexOf('async search(query: string');
    const searchEnd = src.indexOf('async retrieve(query: string');
    assert.ok(meeting >= 0);
    assert.ok(global > meeting);
    assert.ok(search >= 0);
    assert.ok(searchEnd > search);

    const meetingBlock = src.slice(meeting, global);
    const globalEnd = src.indexOf('async *query(', global);
    const globalBlock = src.slice(global, globalEnd > 0 ? globalEnd : global + 5000);
    const searchBlock = src.slice(search, searchEnd);

    assert.match(meetingBlock, /this\.search\(/);
    assert.match(meetingBlock, /forceDocumentGrounding:\s*true/);
    assert.doesNotMatch(meetingBlock, /this\.retriever\.retrieve\(/);
    assert.doesNotMatch(meetingBlock, /observeCanonicalRagShadowIfEnabled/);
    assert.doesNotMatch(meetingBlock, /scopeId:\s*meetingId/);
    assert.match(globalBlock, /this\.search\(/);
    assert.doesNotMatch(globalBlock, /this\.retriever\.retrieveGlobal\(/);
    assert.doesNotMatch(globalBlock, /observeCanonicalRagShadowIfEnabled/);
    assert.match(searchBlock, /observeCanonicalRagShadowIfEnabled/);
    assert.doesNotMatch(meetingBlock, /canonical.*results.*replace/i);
    assert.doesNotMatch(globalBlock, /canonical.*results.*replace/i);
  });

  test('unified mode retrieval marks the path as already observed', () => {
    const adapter = source('electron/rag/adapters/ModeRagAdapter.ts');
    const modes = source('electron/services/ModesManager.ts');
    const retriever = source('electron/services/ModeContextRetriever.ts');

    assert.match(adapter, /canonicalShadowAlreadyHandled:\s*true/);
    assert.match(modes, /this\.modeContextRetriever\.retrieveHybrid\(mode, files, options\)/);
    assert.match(retriever, /canonicalShadowAlreadyHandled\?:\s*boolean/);
    assert.match(retriever, /if \(options\.canonicalShadowAlreadyHandled\) return;/);
  });

  test('direct mode retrieval observes at the shared ModeContextRetriever boundary', () => {
    const src = source('electron/services/ModeContextRetriever.ts');
    assert.match(src, /private observeCanonicalShadow\(/);
    assert.match(src, /sourceTypes:\s*\['mode'\]/);
    assert.match(src, /files\.map\(file => String\(file\.id/);
    assert.match(src, /this\.observeCanonicalShadow\(mode, files, options/);
  });

  test('direct meeting and personal retrieval ports observe after legacy retrieval', () => {
    const meeting = source('electron/context-intelligence/retrieval/meeting-retrieval-port.ts');
    const personal = source('electron/context-intelligence/retrieval/personal-file-retrieval-port.ts');

    assert.match(meeting, /observeCanonicalRagShadowIfEnabled\(query/);
    assert.match(meeting, /sourceTypes:\s*\['meeting'\]/);
    assert.match(meeting, /legacyResultCount:\s*res\?\.chunks\?\.length/);
    assert.doesNotMatch(meeting, /scopeId:\s*input\.currentMeetingId/);

    assert.match(personal, /observeCanonicalRagShadowIfEnabled\(query/);
    assert.match(personal, /sourceTypes:\s*\['personal'\]/);
    assert.match(personal, /legacyResultCount:\s*items\.length/);
  });

  test('direct Person 1 prompt and IPC boundaries observe personal retrieval', () => {
    const prompt = source('electron/personalKnowledge/person1PromptContext.ts');
    const ipc = source('electron/personalKnowledge/person1Ipc.ts');

    assert.match(prompt, /getPersonalKnowledgeManager\(\)\.buildPromptContext\(question\)/);
    assert.match(prompt, /observeCanonicalRagShadowIfEnabled\(question/);
    assert.match(prompt, /manager\.searchRelevantAsync\(question, 6\)/);

    assert.match(ipc, /personal-files:search/);
    assert.match(ipc, /const results = getPersonalKnowledgeManager\(\)\.search\(query\)/);
    assert.match(ipc, /observeCanonicalRagShadowIfEnabled\(query/);
  });

  test('shared manager and low-level retrieval algorithms are not instrumented', () => {
    const manager = source('electron/personalKnowledge/PersonalKnowledgeManager.ts');
    const lowMode = source('electron/services/modes/ModeHybridRetriever.ts');
    const ragRetriever = source('electron/rag/RAGRetriever.ts');

    assert.doesNotMatch(manager, /observeCanonicalRagShadowIfEnabled/);
    assert.doesNotMatch(lowMode, /observeCanonicalRagShadowIfEnabled/);
    assert.doesNotMatch(ragRetriever, /observeCanonicalRagShadowIfEnabled/);
  });

  test('shadow source filters are forwarded accurately', async () => {
    const calls = [];
    const storage = {
      searchLexical(query, options) {
        calls.push({ query, options });
        return [{}];
      },
    };
    const service = new CanonicalRagShadowService(storage);
    const diagnostic = await service.observe('project update', {
      sourceTypes: ['meeting'],
      sourceFilters: { sourceIds: ['m1', 'm2'], scopeId: 'm1' },
      legacyResultCount: 4,
    });

    assert.equal(diagnostic.succeeded, true);
    assert.equal(diagnostic.canonicalResultCount, 2);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(c => c.options.sourceId), ['m1', 'm2']);
    assert.deepEqual(calls.map(c => c.options.scopeId), ['m1', 'm1']);
  });

  test('shadow remains observe-only when the flag helper is used by a boundary', async () => {
    const serviceSource = source('electron/rag/canonical/CanonicalRagShadowService.ts');
    assert.match(serviceSource, /isIntelligenceFlagEnabled\('canonicalRagShadow'\)/);
    assert.match(serviceSource, /return await service\.observe\(query, options\)/);
    assert.match(serviceSource, /legacy retrieval remains unchanged/);
  });

  test('direct hybrid mode fallback produces exactly one shadow observation', async () => {
    const retriever = new ModeContextRetriever();
    let observations = 0;
    const previousObserve = retriever.observeCanonicalShadow;
    retriever.observeCanonicalShadow = function observeCanonicalShadowForTest(mode, files, options, legacyResultCount) {
      if (options.canonicalShadowAlreadyHandled) return;
      observations += 1;
      return previousObserve.call(this, mode, files, options, legacyResultCount);
    };
    retriever._hybridRetriever = { retrieve: async () => { throw new Error('hybrid unavailable'); } };

    const mode = { id: 'mode-test', name: 'Test', customContext: '' };
    const files = [];
    let fallbackOptions;
    const fakeManager = {
      resolveMode: () => mode,
      getReferenceFiles: () => files,
      modeContextRetriever: retriever,
      buildRetrievedActiveModeContextBlock: (query, transcript, tokenBudget, answerType, excludeCustomContext, pinnedModeId, retrievalOptions) => {
        fallbackOptions = retrievalOptions;
        return retriever.retrieve(mode, files, {
          query,
          ...(retrievalOptions ?? {}),
        }).formattedContext;
      },
    };

    // Exercise only the manager's hybrid -> lexical fallback path. The hybrid
    // call itself throws, so retrieveHybrid() must record the single shadow;
    // the fallback receives the suppression marker and must not record another.
    await ModesManager.prototype.buildRetrievedActiveModeContextBlockHybrid.call(
      fakeManager,
      'project update',
    );

    assert.equal(observations, 1);
    assert.equal(fallbackOptions?.canonicalShadowAlreadyHandled, true);
  });

  test('unified mode suppression is runtime-safe through the adapter marker', async () => {
    const retriever = new ModeContextRetriever();
    let observations = 0;
    retriever.observeCanonicalShadow = () => { observations += 1; };
    retriever._hybridRetriever = {
      retrieve: async () => ({ chunks: [], formattedContext: '', usedFallback: true, usedHybrid: false }),
    };

    const mode = { id: 'mode-unified', name: 'Unified', customContext: '' };
    const files = [];
    await retriever.retrieveHybrid(mode, files, {
      query: 'project update',
      canonicalShadowAlreadyHandled: true,
    });
    assert.equal(observations, 0);
  });

  test('canonical meeting shadow retrieves by sourceId without requiring a scopeId', async () => {
    const db = makeCanonicalDb();
    const storage = new CanonicalRagStorage(db);
    seedReadyMeeting(storage, 'meeting-1');

    const service = new CanonicalRagShadowService(storage);
    const diagnostic = await service.observe('project update', {
      sourceTypes: ['meeting'],
      sourceFilters: { sourceIds: ['meeting-1'] },
      legacyResultCount: 1,
    });
    assert.equal(diagnostic.succeeded, true);
    assert.equal(diagnostic.canonicalResultCount, 1);
    db.close();
  });
});
