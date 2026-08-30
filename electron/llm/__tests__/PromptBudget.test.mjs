// electron/llm/__tests__/PromptBudget.test.mjs
//
// Sprint S3 — Context Engine + token/window/output limits (Problems 8, 9,
// 17-19, 31). Covers the two acceptance checks named in the plan:
//   - "hi" stays under 2000 tokens estimated (trivial-query gate + budget fit)
//   - Groq preflight skips/trims context that exceeds its effective ceiling
// plus the supporting pieces (isTrivialQuery, resolveProviderCeiling,
// resolveMaxOutputTokens) that back those two behaviors.
//
// Run: npm run build:electron, then node --test on this file (or `npm run
// test:llm`, which does both).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distLlm = path.resolve(__dirname, '../../../dist-electron/electron/llm');

const { fitPromptToBudget, resolveProviderCeiling } =
  await import(pathToFileURL(path.join(distLlm, 'promptBudget.js')).href);
const { isTrivialQuery, assembleContext } =
  await import(pathToFileURL(path.join(distLlm, 'contextEngine.js')).href);
const { getModelCapabilities, resolveMaxOutputTokens, estimateTokens } =
  await import(pathToFileURL(path.join(distLlm, 'modelCapabilities.js')).href);

const CLOUD_CAPS = getModelCapabilities('gemini-2.5-flash', false);
const GROQ_CAPS = getModelCapabilities('qwen/qwen3.6-27b', false); // isLargeGroqModel → tier 'cloud'

describe('isTrivialQuery / assembleContext — trivial-query gate', () => {
  test('bare greetings are trivial', () => {
    for (const q of ['hi', 'hello', 'Hey!', 'thanks', 'ok']) {
      assert.equal(isTrivialQuery(q), true, `expected "${q}" to be trivial`);
    }
  });

  test('short statements without a question mark are trivial; a real question is not', () => {
    assert.equal(isTrivialQuery('sounds good'), true);
    assert.equal(isTrivialQuery('What is the time complexity of quicksort?'), false);
    assert.equal(isTrivialQuery('short but has a ?'), false);
  });

  test('assembleContext drops every layer for a trivial query, keeps them for a real one', () => {
    const layers = [{ id: 'history', text: 'previous turn', priority: 0 }];
    assert.deepEqual(assembleContext({ query: 'hi', layers }).layers, []);
    const kept = assembleContext({ query: 'What did we discuss earlier?', layers });
    assert.equal(kept.layers.length, 1);
  });

  test('empty-text layers are filtered even for a real query', () => {
    const layers = [{ id: 'history', text: '   ', priority: 0 }];
    assert.deepEqual(assembleContext({ query: 'a real question?', layers }).layers, []);
  });
});

describe('fitPromptToBudget — "hi" stays under 2000 tokens estimated', () => {
  test('trivial query + no layers fits well under 2000 tokens on a cloud model', () => {
    const system = 'You are Natively, a helpful AI copilot.'.repeat(3); // small, realistic persona snippet
    const { layers } = assembleContext({
      query: 'hi',
      layers: [{ id: 'history', text: 'a'.repeat(50_000), priority: 0 }], // would blow the budget if not gated
    });
    const result = fitPromptToBudget({ system, user: 'hi', layers, caps: CLOUD_CAPS });
    const totalTokens = estimateTokens(result.system) + estimateTokens(result.user);
    assert.ok(totalTokens < 2000, `expected < 2000 tokens, got ${totalTokens}`);
    assert.deepEqual(result.dropped, []); // nothing to drop — the gate already emptied layers
  });

  test('a plain "hi" with no layers at all is trivially small', () => {
    const result = fitPromptToBudget({ system: 'System prompt.', user: 'hi', caps: CLOUD_CAPS });
    assert.ok(estimateTokens(result.system) + estimateTokens(result.user) < 2000);
  });
});

describe('fitPromptToBudget — Groq preflight skips when over ceiling', () => {
  test('resolveProviderCeiling reports the Groq effective input ceiling', () => {
    assert.equal(resolveProviderCeiling('groq'), 8000);
    assert.equal(resolveProviderCeiling('gemini'), undefined);
    assert.equal(resolveProviderCeiling(undefined), undefined);
  });

  test('a large layer is dropped under the Groq ceiling even though the model tier reports a 128k window', () => {
    assert.ok(GROQ_CAPS.maxContextTokens >= 100_000, 'sanity: Groq model tier reports a large context window');
    const bigLayer = { id: 'fileChunks', text: 'x'.repeat(60_000), priority: 0 }; // ~15k estimated tokens
    const result = fitPromptToBudget({
      system: 'System prompt.',
      user: 'Summarize the attached document.',
      layers: [bigLayer],
      caps: GROQ_CAPS,
      providerCeiling: resolveProviderCeiling('groq'),
    });
    assert.deepEqual(result.dropped, ['fileChunks']);
    const totalTokens = estimateTokens(result.system) + estimateTokens(result.user);
    assert.ok(totalTokens <= 8000, `expected to stay under the Groq ceiling, got ${totalTokens}`);
  });

  test('without a providerCeiling the same layer would have been kept (proves the ceiling is what triggers the drop)', () => {
    const bigLayer = { id: 'fileChunks', text: 'x'.repeat(60_000), priority: 0 };
    const result = fitPromptToBudget({
      system: 'System prompt.',
      user: 'Summarize the attached document.',
      layers: [bigLayer],
      caps: GROQ_CAPS, // no providerCeiling — 128k window, plenty of room
    });
    assert.deepEqual(result.dropped, []);
  });

  test('when even system+user alone exceed the ceiling, user is trimmed and every layer is dropped', () => {
    const hugeUser = Array.from({ length: 3000 }, (_, i) => `line ${i}: filler content`).join('\n');
    const result = fitPromptToBudget({
      system: 'System prompt.',
      user: hugeUser,
      layers: [{ id: 'history', text: 'z'.repeat(1000), priority: 0 }],
      caps: GROQ_CAPS,
      providerCeiling: 8000,
    });
    assert.ok(result.dropped.includes('history'));
    assert.ok(result.dropped.includes('user:truncated'));
    assert.ok(result.user.length < hugeUser.length);
  });
});

describe('resolveMaxOutputTokens', () => {
  test('an explicit binding override always wins', () => {
    assert.equal(resolveMaxOutputTokens({ id: 'qwen/qwen3.6-27b', provider: 'groq', maxOutputTokens: 1234 }), 1234);
  });

  test('a caller fallback preserves existing behavior when no override is set', () => {
    assert.equal(resolveMaxOutputTokens({ id: 'qwen/qwen3.6-27b', provider: 'groq' }, { fallback: 8192 }), 8192);
  });

  test('uncapped preserves "no cap sent" (Ollama num_predict design) when no override/fallback exists', () => {
    assert.equal(resolveMaxOutputTokens({ id: 'llama3.1:8b', provider: 'ollama' }, { uncapped: true }), undefined);
  });

  test('falls back to getModelCapabilities when neither override, fallback, nor uncapped is given', () => {
    const expected = getModelCapabilities('llama3.1:8b', true).outputBudgetTokens;
    assert.equal(resolveMaxOutputTokens({ id: 'llama3.1:8b', provider: 'ollama' }, { isOllama: true }), expected);
  });
});
