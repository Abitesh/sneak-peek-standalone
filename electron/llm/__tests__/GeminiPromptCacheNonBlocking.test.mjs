// Verifies GeminiPromptCache.getLiveOrKickoff is non-blocking on a cold cache:
// it returns null immediately (so the caller answers with systemInstruction, no
// TTFT hit), kicks off creation in the background, and returns the live name on
// the NEXT call once creation resolves. This is the fix for the ~5s first-token
// stall when the prewarm primed a different model than the one answering.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.resolve(__dirname, '../../../dist-electron/electron/llm/GeminiPromptCache.js');
const { GeminiPromptCache } = await import(pathToFileURL(modPath).href);

// Prompt must exceed MIN_PROMPT_CHARS (4500) to be cache-eligible.
const BIG_PROMPT = 'x'.repeat(6000);

// Fake GoogleGenAI client whose caches.create resolves after a tick, letting us
// assert the hot path never waits on it.
function makeClient() {
  let createCalls = 0;
  const client = {
    caches: {
      create: async () => {
        createCalls++;
        await new Promise((r) => setTimeout(r, 20));
        return { name: `cachedContents/fake-${createCalls}` };
      },
    },
  };
  return { client, createCalls: () => createCalls };
}

describe('GeminiPromptCache.getLiveOrKickoff (non-blocking hot path)', () => {
  let cache;
  beforeEach(() => {
    cache = new GeminiPromptCache();
  });

  test('cold cache → returns null synchronously (no await, no block)', () => {
    const { client } = makeClient();
    const before = Date.now();
    const name = cache.getLiveOrKickoff(client, 'gemini-3.1-flash-lite', BIG_PROMPT);
    const elapsed = Date.now() - before;
    assert.equal(name, null, 'cold cache must return null so caller uses systemInstruction');
    assert.ok(elapsed < 5, `must be synchronous, took ${elapsed}ms`);
  });

  test('kicks off background creation; next call returns the live name', async () => {
    const { client, createCalls } = makeClient();
    assert.equal(cache.getLiveOrKickoff(client, 'gemini-3.1-flash-lite', BIG_PROMPT), null);
    // Let the background create resolve.
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(createCalls(), 1, 'exactly one background create kicked off');
    const name = cache.getLiveOrKickoff(client, 'gemini-3.1-flash-lite', BIG_PROMPT);
    assert.match(name ?? '', /cachedContents\/fake-1/, 'second call reuses the now-live cache');
  });

  test('concurrent cold calls kick off only ONE create (dedupe)', async () => {
    const { client, createCalls } = makeClient();
    cache.getLiveOrKickoff(client, 'gemini-3.1-flash-lite', BIG_PROMPT);
    cache.getLiveOrKickoff(client, 'gemini-3.1-flash-lite', BIG_PROMPT);
    cache.getLiveOrKickoff(client, 'gemini-3.1-flash-lite', BIG_PROMPT);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(createCalls(), 1, 'inflight dedupe — only one create for the same key');
  });

  test('prompt below MIN_PROMPT_CHARS → null, no create attempted', async () => {
    const { client, createCalls } = makeClient();
    const name = cache.getLiveOrKickoff(client, 'gemini-3.1-flash-lite', 'too short');
    assert.equal(name, null);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(createCalls(), 0, 'tiny prompts are not cache-eligible');
  });

  test('different model → separate cache entry (no cross-model reuse)', async () => {
    const { client, createCalls } = makeClient();
    cache.getLiveOrKickoff(client, 'gemini-3.5-flash', BIG_PROMPT);
    cache.getLiveOrKickoff(client, 'gemini-3.1-flash-lite', BIG_PROMPT);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(createCalls(), 2, 'each model keys its own cache — prewarm of one does not serve the other');
  });
});
