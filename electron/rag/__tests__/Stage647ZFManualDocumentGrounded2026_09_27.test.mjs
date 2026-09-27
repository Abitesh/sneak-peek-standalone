// electron/rag/__tests__/Stage647ZFManualDocumentGrounded2026_09_27.test.mjs
//
// Stage 6: prove 47ZF manual document-grounded behavior (streaming + non-streaming).
// - universal search → manualContext → renderManualContext
// - success → legacy buildRetrievedActiveModeContextBlockHybrid NOT called after
// - empty/throw universal → legacy fallback once
// - no second RAGManager (provider injection; never `new RAGManager` in LLMHelper)
//
// Run: npm run build:electron && node --test electron/rag/__tests__/Stage647ZFManualDocumentGrounded2026_09_27.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const require = createRequire(import.meta.url);
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const llmHelperSrc = read('electron/LLMHelper.ts');
const mainSrc = read('electron/main.ts');
const { LLMHelper } = require(path.join(root, 'dist-electron/electron/LLMHelper.js'));
const { renderManualContext } = require(path.join(root, 'dist-electron/electron/rag/ManualRenderContext.js'));

const MODE_CHUNK = 'Reference doc: system architecture has three phases — ingest, index, serve.';

function makeHelper() {
  const helper = Object.create(LLMHelper.prototype);
  helper.ragManagerProvider = undefined;
  return helper;
}

function okManualResponse(text) {
  return {
    status: 'ok',
    manualContext: {
      items: [{ text, sourceId: 'mode-ref-1', documentId: 'doc-1', documentName: 'arch.pdf' }],
    },
  };
}

describe('Stage 6: 47ZF wiring (source)', () => {
  test('main wires lazy setRagManagerProvider for LLMHelper and IntelligenceManager', () => {
    assert.match(
      mainSrc,
      /getLLMHelper\(\)\.setRagManagerProvider\(\s*\(\)\s*=>\s*this\.ragManager\s*\?\?\s*null/,
      'LLMHelper must receive the application-owned RAGManager via provider',
    );
    assert.match(
      mainSrc,
      /intelligenceManager\?\.setRagManagerProvider\?\.\(\s*\(\)\s*=>\s*this\.ragManager\s*\?\?\s*null/,
      'IntelligenceManager must receive the same application-owned RAGManager',
    );
  });

  test('LLMHelper never constructs a second RAGManager', () => {
    assert.doesNotMatch(llmHelperSrc, /new\s+RAGManager\s*\(/);
    assert.match(llmHelperSrc, /setRagManagerProvider\(/);
    assert.match(llmHelperSrc, /this\.ragManagerProvider\?\.\(\)/);
  });

  test('retrieveUniversalModeContext is search → manualContext → renderManualContext', () => {
    const start = llmHelperSrc.indexOf('private async retrieveUniversalModeContext(');
    const end = llmHelperSrc.indexOf('private async retrieveManualDocumentGroundedContext(', start);
    const body = llmHelperSrc.slice(start, end);
    assert.match(body, /ragManager\.search\(/);
    assert.match(body, /selectedSources:\s*\['mode-reference'\]/);
    assert.match(body, /allowedSources:\s*\['mode-reference'\]/);
    assert.match(body, /response\.manualContext/);
    assert.match(body, /return renderManualContext\(response\.manualContext\)/);
  });

  test('streaming + non-streaming doc-grounded use shared 47ZF resolver', () => {
    assert.match(llmHelperSrc, /private async resolveManualDocumentGroundedContextWithLegacyFallback\(/);
    const calls = llmHelperSrc.match(/this\.resolveManualDocumentGroundedContextWithLegacyFallback\(/g) || [];
    assert.equal(calls.length, 2, 'expected non-streaming + streaming call sites');
    assert.match(
      llmHelperSrc,
      /buildRetrievedActiveModeContextBlockHybrid\(message, undefined, undefined, undefined, true\)/,
    );
    assert.match(
      llmHelperSrc,
      /buildRetrievedActiveModeContextBlockHybrid\(\s*message, undefined, undefined, undefined, true, pin/,
    );
  });
});

describe('Stage 6: 47ZF behavioral (retrieve + resolve)', () => {
  test('success: search → manualContext → renderManualContext; legacy NOT called', async () => {
    const helper = makeHelper();
    let searchCalls = 0;
    let legacyCalls = 0;

    helper.setRagManagerProvider(() => ({
      search: async (query, options) => {
        searchCalls += 1;
        assert.equal(query, 'What are the three phases?');
        assert.deepEqual(options.selectedSources, ['mode-reference']);
        assert.deepEqual(options.allowedSources, ['mode-reference']);
        assert.equal(options.excludeCustomContext, true);
        return okManualResponse(MODE_CHUNK);
      },
    }));

    const rendered = await helper.resolveManualDocumentGroundedContextWithLegacyFallback(
      'What are the three phases?',
      'mode-doc-1',
      async () => {
        legacyCalls += 1;
        return 'LEGACY_SHOULD_NOT_RUN';
      },
    );

    assert.equal(searchCalls, 1);
    assert.equal(legacyCalls, 0);
    assert.match(rendered, /three phases|ingest|index|serve/i);
    assert.equal(rendered, renderManualContext(okManualResponse(MODE_CHUNK).manualContext));
  });

  test('empty universal → legacy fallback once', async () => {
    const helper = makeHelper();
    let searchCalls = 0;
    let legacyCalls = 0;

    helper.setRagManagerProvider(() => ({
      search: async () => {
        searchCalls += 1;
        return { status: 'ok', manualContext: { items: [] } };
      },
    }));

    const rendered = await helper.resolveManualDocumentGroundedContextWithLegacyFallback(
      'missing docs?',
      'mode-doc-1',
      async () => {
        legacyCalls += 1;
        return 'LEGACY_HYBRID_BLOCK';
      },
    );

    assert.equal(searchCalls, 1);
    assert.equal(legacyCalls, 1);
    assert.equal(rendered, 'LEGACY_HYBRID_BLOCK');
  });

  test('throw universal → legacy fallback once', async () => {
    const helper = makeHelper();
    let searchCalls = 0;
    let legacyCalls = 0;

    helper.setRagManagerProvider(() => ({
      search: async () => {
        searchCalls += 1;
        throw new Error('simulated universal RAG failure');
      },
    }));

    const rendered = await helper.resolveManualDocumentGroundedContextWithLegacyFallback(
      'failing search',
      'mode-doc-1',
      async () => {
        legacyCalls += 1;
        return 'LEGACY_AFTER_THROW';
      },
    );

    assert.equal(searchCalls, 1);
    assert.equal(legacyCalls, 1);
    assert.equal(rendered, 'LEGACY_AFTER_THROW');
  });

  test('no provider → empty universal path → legacy once (still no second RAGManager)', async () => {
    const helper = makeHelper();
    // Intentionally no setRagManagerProvider — must not construct RAGManager.
    let legacyCalls = 0;
    const rendered = await helper.resolveManualDocumentGroundedContextWithLegacyFallback(
      'no provider',
      undefined,
      async () => {
        legacyCalls += 1;
        return 'LEGACY_NO_PROVIDER';
      },
    );
    assert.equal(legacyCalls, 1);
    assert.equal(rendered, 'LEGACY_NO_PROVIDER');
  });

  test('retrieveManualDocumentGroundedContext stays mode-reference-only', async () => {
    const helper = makeHelper();
    const searches = [];
    helper.setRagManagerProvider(() => ({
      search: async (query, options) => {
        searches.push({ query, options });
        return okManualResponse(MODE_CHUNK);
      },
    }));

    const out = await helper.retrieveManualDocumentGroundedContext('phase question', 'mode-x');
    assert.equal(searches.length, 1);
    assert.deepEqual(searches[0].options.selectedSources, ['mode-reference']);
    assert.deepEqual(searches[0].options.allowedSources, ['mode-reference']);
    assert.match(out, /three phases/i);
  });
});
