import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CanonicalRagShadowService } from '../../../dist-electron/electron/rag/canonical/CanonicalRagShadowService.js';

const root = process.cwd();

function source(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('Change 25 Phase 6.4 canonical shadow boundaries', () => {
  test('queryMeeting and queryGlobal observe the canonical shadow without replacing legacy results', () => {
    const src = source('electron/rag/RAGManager.ts');

    const meeting = src.indexOf('async *queryMeeting(');
    const global = src.indexOf('async *queryGlobal(');
    assert.ok(meeting >= 0);
    assert.ok(global > meeting);

    const meetingBlock = src.slice(meeting, global);
    const globalEnd = src.indexOf('async *query(', global);
    const globalBlock = src.slice(global, globalEnd > 0 ? globalEnd : global + 5000);

    assert.match(meetingBlock, /this\.retriever\.retrieve\(query, \{ meetingId \}\)/);
    assert.match(meetingBlock, /observeCanonicalRagShadowIfEnabled/);
    assert.match(globalBlock, /this\.retriever\.retrieveGlobal\(query\)/);
    assert.match(globalBlock, /observeCanonicalRagShadowIfEnabled/);
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
});
