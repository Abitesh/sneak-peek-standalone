// electron/rag/__tests__/UniversalChatSourceRouting2026_09_27.test.mjs
//
// Stage 2 TDD: planner-led chat retrieval allowlist.
// - IntelligenceEngine WTA prefetch must NOT force selectedSources: ['mode-reference']
// - Mode-grounded / 47ZF paths keep mode-reference-only via retrieveUniversalModeContext
// - RagQueryPlanner skip still holds for generative chitchat under the allowlist
//
// Run: npm run build:electron && node --test electron/rag/__tests__/UniversalChatSourceRouting2026_09_27.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('buildUniversalChatAllowedSources helper', () => {
  test('defaults to mode-reference + knowledge + personal-files (V3-style allowlist)', async () => {
    const mod = await import(pathToFileURL(
      path.join(root, 'dist-electron/electron/rag/universalChatAllowedSources.js'),
    ).href);
    assert.deepEqual(
      mod.buildUniversalChatAllowedSources(),
      ['mode-reference', 'knowledge', 'personal-files'],
    );
  });

  test('can omit personal-files / meeting stays opt-in', async () => {
    const mod = await import(pathToFileURL(
      path.join(root, 'dist-electron/electron/rag/universalChatAllowedSources.js'),
    ).href);
    assert.deepEqual(
      mod.buildUniversalChatAllowedSources({ includePersonalFiles: false }),
      ['mode-reference', 'knowledge'],
    );
    assert.ok(
      mod.buildUniversalChatAllowedSources({ includeMeeting: true }).includes('meeting'),
    );
  });
});

describe('IntelligenceEngine source routing (source-scan)', () => {
  const src = read('electron/IntelligenceEngine.ts');

  test('retrieveUniversalModeContext stays mode-reference-only (47ZF / Mode-grounded)', () => {
    const start = src.indexOf('private async retrieveUniversalModeContext(');
    assert.ok(start >= 0);
    const end = src.indexOf('private v3ModeRetrievalContext(', start);
    const body = src.slice(start, end > start ? end : start + 1200);
    assert.match(body, /selectedSources:\s*\['mode-reference'\]/);
    assert.match(body, /allowedSources:\s*\['mode-reference'\]/);
  });

  test('WTA prefetch uses retrieveUniversalChatContext (planner-led, no selectedSources hardcode)', () => {
    assert.match(
      src,
      /this\.retrieveUniversalChatContext\(\s*wtaPrefetchQuery/,
      'WTA prefetch must call retrieveUniversalChatContext',
    );
    // The prefetch call site must not still hardcode mode-only selectedSources
    // on the same retrieveUniversalModeContext(wtaPrefetchQuery…) line.
    assert.doesNotMatch(
      src,
      /this\.retrieveUniversalModeContext\(\s*wtaPrefetchQuery/,
      'WTA prefetch must leave retrieveUniversalModeContext',
    );
  });

  test('doc-grounded validator path keeps retrieveUniversalModeContext (mode-only)', () => {
    assert.match(
      src,
      /this\.retrieveUniversalModeContext\(\s*docQuestion/,
      'doc-grounded validation must stay on mode-only retrieveUniversalModeContext',
    );
  });

  test('retrieveUniversalChatContext omits selectedSources and uses shared allowlist', () => {
    const start = src.indexOf('private async retrieveUniversalChatContext(');
    assert.ok(start >= 0, 'retrieveUniversalChatContext must exist');
    const end = src.indexOf('private async retrieveUniversalModeContext(', start);
    const body = src.slice(start, end > start ? end : start + 1500);
    assert.doesNotMatch(body, /selectedSources\s*:/);
    assert.match(body, /buildUniversalChatAllowedSources\s*\(/);
    assert.match(body, /allowedSources\s*:/);
  });
});

describe('LLMHelper source routing (source-scan)', () => {
  const src = read('electron/LLMHelper.ts');

  test('retrieveUniversalModeContext stays mode-reference-only', () => {
    const start = src.indexOf('private async retrieveUniversalModeContext(');
    assert.ok(start >= 0);
    const body = src.slice(start, start + 900);
    assert.match(body, /selectedSources:\s*\['mode-reference'\]/);
    assert.match(body, /allowedSources:\s*\['mode-reference'\]/);
  });

  test('retrieveManualDocumentGroundedContext still delegates to mode-only helper', () => {
    assert.match(
      src,
      /retrieveManualDocumentGroundedContext[\s\S]*?return this\.retrieveUniversalModeContext\(/,
    );
  });

  test('general-chat paths use retrieveUniversalChatContext', () => {
    assert.match(src, /private async retrieveUniversalChatContext\(/);
    // suggestion + non-streaming + streaming non-governed retrieval
    assert.match(src, /generateSuggestion[\s\S]*retrieveUniversalChatContext\(/);
    assert.match(
      src,
      /modeContextBlock = await this\.retrieveUniversalChatContext\(\s*message,/,
    );
  });

  test('retrieveUniversalChatContext omits selectedSources', () => {
    const start = src.indexOf('private async retrieveUniversalChatContext(');
    assert.ok(start >= 0);
    const end = src.indexOf('private async retrieveUniversalModeContext(', start);
    const body = src.slice(start, end > start ? end : start + 1200);
    assert.doesNotMatch(body, /selectedSources\s*:/);
    assert.match(body, /buildUniversalChatAllowedSources\s*\(/);
  });
});

describe('planner skip still holds under chat allowlist', () => {
  test('generative chitchat remains skip:true with chat allowedSources', async () => {
    const helperPath = path.join(root, 'dist-electron/electron/rag/resolveRagSearchSources.js');
    const plannerPath = path.join(root, 'dist-electron/electron/rag/RagQueryPlanner.js');
    const allowPath = path.join(root, 'dist-electron/electron/rag/universalChatAllowedSources.js');
    const { resolveRagSearchSources } = await import(pathToFileURL(helperPath).href);
    const { RagQueryPlanner } = await import(pathToFileURL(plannerPath).href);
    const { buildUniversalChatAllowedSources } = await import(pathToFileURL(allowPath).href);
    const planner = new RagQueryPlanner();
    const plan = planner.plan('write me a funny birthday message');
    const resolved = resolveRagSearchSources(plan, {
      allowedSources: buildUniversalChatAllowedSources(),
    });
    assert.equal(plan.needsDocumentEvidence, false);
    assert.equal(resolved.skip, true);
    assert.deepEqual(resolved.sources, []);
  });

  test('personal query plans personal-files when allowlist includes it and selectedSources omitted', async () => {
    const plannerPath = path.join(root, 'dist-electron/electron/rag/RagQueryPlanner.js');
    const helperPath = path.join(root, 'dist-electron/electron/rag/resolveRagSearchSources.js');
    const allowPath = path.join(root, 'dist-electron/electron/rag/universalChatAllowedSources.js');
    const { RagQueryPlanner } = await import(pathToFileURL(plannerPath).href);
    const { resolveRagSearchSources } = await import(pathToFileURL(helperPath).href);
    const { buildUniversalChatAllowedSources } = await import(pathToFileURL(allowPath).href);
    const planner = new RagQueryPlanner();
    const plan = planner.plan('What projects are on my resume?', undefined, {
      hasPersonalFiles: true,
      hasModeReferenceFiles: true,
    });
    const resolved = resolveRagSearchSources(plan, {
      allowedSources: buildUniversalChatAllowedSources(),
    });
    assert.equal(resolved.skip, false);
    assert.ok(resolved.sources.includes('personal-files'));
    assert.equal(resolved.sources.includes('mode-reference'), false);
  });
});
