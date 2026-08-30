// electron/llm/__tests__/RoutingFallbackCascade2026_08_31.test.mjs
//
// Sprint S2 (ai-provider-pipeline-fix, Problems 4/6/7/10/25-28) regression
// tests for the routing + fallback rewrite of `_streamChatInner`:
//
//   1. An Ollama selection dispatches ONLY to Ollama — no cloud cascade runs,
//      even when cloud clients are configured (Problem 25).
//   2. A primary provider that fails BEFORE emitting any text falls over to a
//      verified alternative, reusing the exact same prompt (Problem 28), and
//      `getLastStreamRouting()` reports the fallback honestly (Problem 27).
//   3. A selected-but-undispatchable provider (no client configured) does NOT
//      produce a false "no provider available" error when a verified
//      alternative exists (Problem 10) — and the reverse: when NOTHING is
//      dispatchable, the error names the real cause.
//
// Pattern follows the existing DisabledProviderRouting2026_08_01.test.mjs:
// `Object.create(LLMHelper.prototype)`, stub every `streamWith*` (they are
// captured by name — `dispatchProviderFamily`/`attemptProviderFamily`
// themselves are deliberately NOT prefixed `streamWith*`, see the 2026-08-31
// rename, so they are never accidentally stubbed out here), and drive the
// real `_streamChatInner` end to end.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = (p) => path.join(__dirname, '../../../dist-electron/electron', p);

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: {
    app: { isReady: () => true, getPath: () => os.tmpdir(), getVersion: () => '0.0.0-test' },
    safeStorage: { isEncryptionAvailable: () => false },
  },
};

const { LLMHelper } = require(dist('LLMHelper.js'));
const { bindingFromModelId } = require(dist('llm/providerRegistry.js'));

// CredentialsManager is anchored on globalThis (see CredentialsManager.getInstance),
// so seeding this slot is how `buildVerifiedFallbackCandidates` (S1's
// providerHealth) and `isProviderDisabled` are exercised without a real store.
const CRED_SLOT = '__nativelyCredentialsManagerV1__';
let credBefore;
beforeEach(() => { credBefore = globalThis[CRED_SLOT]; });
afterEach(() => {
  if (credBefore === undefined) delete globalThis[CRED_SLOT];
  else globalThis[CRED_SLOT] = credBefore;
});

function setCredentials({ disabled = [], health = {} } = {}) {
  globalThis[CRED_SLOT] = {
    getDisabledProviders: () => disabled,
    getAllProviderHealth: () => health,
  };
}

function verifiedHealth(family, modelId) {
  return { status: 'verified', authOk: true, lastProbeAt: Date.now(), models: [bindingFromModelId(modelId, family)] };
}

/**
 * Builds a minimal LLMHelper double and drains `_streamChatInner`.
 * `streamers` maps a dispatch-method NAME (`streamWith*`, or the Gemini
 * cascade's own `streamGeminiTextCascade`) to either:
 *   - a string: yield that string once, then return (success)
 *   - a function(...args): a full stub (e.g. to throw, or to record args) —
 *     still wrapped so the call is recorded in `captured` regardless.
 * Every OTHER `streamWith*` prototype method is stubbed to a spy that records
 * its name and returns immediately, so an accidental extra dispatch is always
 * visible in `captured` instead of silently succeeding.
 */
function runInner(message, { model = 'gpt-4o', useOllama = false, ollamaModel, clients = {}, streamers = {} } = {}) {
  const captured = [];
  const h = Object.create(LLMHelper.prototype);
  h.useOllama = useOllama;
  h.ollamaModel = ollamaModel;
  h.checkOllamaAvailable = async () => false;
  h.ensureOllamaModelSelected = async () => false;
  h.currentModelId = model;
  h.pickConfiguredCustomProviderForFallback = () => null;
  h.getActiveModeGroundingInfo = () => null;
  h.isLocalOnlyMode = false;
  for (const [field, value] of Object.entries(clients)) h[field] = value;
  const wrap = (k, override) => async function* (...args) {
    captured.push(k);
    if (typeof override === 'function') { yield* override.call(h, ...args); return; }
    yield override;
  };
  for (const k of Object.getOwnPropertyNames(LLMHelper.prototype)) {
    if (!/^streamWith/.test(k)) continue;
    h[k] = wrap(k, streamers[k] ?? 'ok');
  }
  // Explicit overrides always win — including non-`streamWith*` dispatch
  // methods (currently only the Gemini cascade) that fall outside the sweep
  // above and would otherwise dispatch for real.
  for (const k of Object.keys(streamers)) h[k] = wrap(k, streamers[k]);
  return (async () => {
    let text = '';
    let error = null;
    try {
      for await (const tok of LLMHelper.prototype._streamChatInner.call(
        h, message, undefined, undefined, 'SYS', true, true, [], undefined, 0, undefined,
      )) {
        if (tok !== LLMHelper.TRUNCATION_SENTINEL) text += tok;
      }
    } catch (e) { error = e; }
    return { captured, text, error, routing: LLMHelper.prototype.getLastStreamRouting.call(h) };
  })();
}

describe('ollama-* selection: single dispatch, no cloud cascade', () => {
  test('only streamWithOllama is called, even with cloud clients configured', async () => {
    setCredentials({ health: { openai: verifiedHealth('openai', 'gpt-4o'), claude: verifiedHealth('claude', 'claude-3-5-sonnet') } });
    const { captured, text, error, routing } = await runInner('hello', {
      useOllama: true,
      ollamaModel: 'llama3.2',
      clients: { _openaiClient: {}, _claudeClient: {} },
      streamers: { streamWithOllama: 'ollama answer' },
    });
    assert.equal(error, null, `must not error, got: ${error?.message}`);
    assert.deepEqual(captured, ['streamWithOllama'], 'no cloud provider may be touched when Ollama is selected');
    assert.equal(text, 'ollama answer');
    assert.equal(routing.requestedProvider, 'ollama');
    assert.equal(routing.actualProvider, 'ollama');
    assert.equal(routing.fallbackOccurred, false);
  });
});

describe('primary fails pre-commit → verified fallback, same prompt preserved', () => {
  test('OpenAI throws before any token; Claude (verified) serves the SAME userContent', async () => {
    setCredentials({ health: { claude: verifiedHealth('claude', 'claude-3-5-sonnet-20241022') } });
    const claudeCalls = [];
    const { captured, text, error, routing } = await runInner('what is the capital of France?', {
      model: 'gpt-4o',
      clients: { _openaiClient: {}, _claudeClient: {} },
      streamers: {
        streamWithOpenai: async function* () { throw new Error('OpenAI 500: upstream error'); },
        streamWithClaude: async function* (userContent, _systemPrompt, modelId) {
          claudeCalls.push({ userContent, modelId });
          yield 'Paris is the capital of France.';
        },
      },
    });
    assert.equal(error, null, `fallback must succeed, got: ${error?.message}`);
    assert.equal(text, 'Paris is the capital of France.');
    assert.deepEqual(captured, ['streamWithOpenai', 'streamWithClaude'], 'exactly one pre-commit failure then exactly one fallback attempt');
    assert.equal(claudeCalls.length, 1);
    assert.match(claudeCalls[0].userContent, /what is the capital of France\?/, 'the fallback must receive the SAME assembled prompt the primary would have (Problem 28)');
    assert.equal(claudeCalls[0].modelId, 'claude-3-5-sonnet-20241022', 'the fallback dispatches the VERIFIED model id, not a guess');
    // Problem 27 — model-fidelity metadata.
    assert.equal(routing.requestedProvider, 'openai');
    assert.equal(routing.requestedModel, 'gpt-4o');
    assert.equal(routing.actualProvider, 'claude');
    assert.equal(routing.actualModel, 'claude-3-5-sonnet-20241022');
    assert.equal(routing.fallbackOccurred, true);
  });

  test('a provider is never retried twice in the same turn, even if it also appears verified', async () => {
    // openai is BOTH the selection and (hypothetically) verified — must not
    // be attempted twice just because it shows up in providerHealth too.
    setCredentials({ health: { openai: verifiedHealth('openai', 'gpt-4o'), gemini: verifiedHealth('gemini', 'gemini-2.0-flash') } });
    const { captured, error } = await runInner('hi', {
      model: 'gpt-4o',
      clients: { _openaiClient: {}, _client: {} },
      streamers: {
        streamWithOpenai: async function* () { throw new Error('rate limited'); },
        streamGeminiTextCascade: 'gemini answer',
      },
    });
    assert.equal(error, null);
    const openaiAttempts = captured.filter((c) => c === 'streamWithOpenai').length;
    assert.equal(openaiAttempts, 1, 'openai must be attempted exactly once, never retried');
    assert.ok(captured.includes('streamGeminiTextCascade'), 'a different verified provider must still be tried');
  });
});

describe('no false "no provider available" when a verified alternative exists', () => {
  test('selected provider has NO client at all; a verified alternative answers', async () => {
    // currentModelId picks OpenAI (isOpenAiModel('gpt-4o') === true) but no
    // _openaiClient was ever configured — selectedIsDispatchable must be
    // false, and the turn must fall straight to the verified cascade instead
    // of throwing "no provider available" while Claude sits right there,
    // verified and ready.
    setCredentials({ health: { claude: verifiedHealth('claude', 'claude-3-5-sonnet-20241022') } });
    const { captured, text, error } = await runInner('are you there?', {
      model: 'gpt-4o',
      clients: { _claudeClient: {} }, // no _openaiClient
      streamers: { streamWithClaude: 'yes, I am here' },
    });
    assert.equal(error, null, `must not falsely report no-provider-available, got: ${error?.message}`);
    assert.equal(text, 'yes, I am here');
    assert.ok(!captured.includes('streamWithOpenai'), 'openai has no client and must never be dispatched');
    assert.deepEqual(captured, ['streamWithClaude']);
  });

  test('genuinely nothing dispatchable and nothing verified → the real error, not a silent hang', async () => {
    setCredentials({ health: {} });
    const { captured, error } = await runInner('hello', {
      model: 'gpt-4o',
      clients: {}, // no clients at all, nothing verified
    });
    assert.ok(error, 'a turn with truly no usable provider must fail loudly');
    assert.equal(captured.length, 0, 'nothing should have been dispatched');
    assert.match(error.message, /No AI provider/, 'the error must be the actionable noProviderAvailableMessage, not a generic crash');
  });
});
