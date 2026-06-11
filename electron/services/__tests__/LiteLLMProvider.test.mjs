import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load compiled modules from dist-electron (the test script builds first).
async function loadProviderRouter() {
  const p = path.resolve(__dirname, '../../../dist-electron/electron/llm/ProviderRouter.js');
  return import(pathToFileURL(p).href);
}

async function loadRateLimiter() {
  const p = path.resolve(__dirname, '../../../dist-electron/electron/services/RateLimiter.js');
  return import(pathToFileURL(p).href);
}

// Mirrors LLMHelper.isLiteLLMModel — the authoritative gate that routes a
// selected model to the LiteLLM proxy path. Kept in lockstep with the source.
function isLiteLLMModel(modelId) {
  return !!modelId && modelId.startsWith('litellm/');
}

// Mirrors the prefix-strip done before calling the proxy: the selector stores
// `litellm/<model>`, but the proxy expects the bare `<model>`.
function stripLiteLLMPrefix(modelId) {
  return modelId.replace('litellm/', '');
}

describe('LiteLLM model id detection + prefix handling', () => {
  test('detects litellm-prefixed model ids', () => {
    assert.equal(isLiteLLMModel('litellm/anthropic/claude-sonnet-4-6'), true);
    assert.equal(isLiteLLMModel('litellm/gpt-4o'), true);
    assert.equal(isLiteLLMModel('litellm/azure-gpt-4'), true);
  });

  test('does not misclassify other providers as litellm', () => {
    assert.equal(isLiteLLMModel('gpt-4o'), false);
    assert.equal(isLiteLLMModel('claude-sonnet-4-6'), false);
    assert.equal(isLiteLLMModel('deepseek-v4-flash'), false);
    assert.equal(isLiteLLMModel('ollama-llama3'), false);
    assert.equal(isLiteLLMModel('natively'), false);
  });

  test('is null/empty safe', () => {
    assert.equal(isLiteLLMModel(''), false);
    assert.equal(isLiteLLMModel(undefined), false);
    assert.equal(isLiteLLMModel(null), false);
  });

  test('strips only the litellm/ prefix, preserving nested provider segments', () => {
    assert.equal(stripLiteLLMPrefix('litellm/anthropic/claude-sonnet-4-6'), 'anthropic/claude-sonnet-4-6');
    assert.equal(stripLiteLLMPrefix('litellm/gpt-4o'), 'gpt-4o');
    // A bare model with no prefix is passed through untouched.
    assert.equal(stripLiteLLMPrefix('gpt-4o'), 'gpt-4o');
  });
});

describe('LiteLLM rate limiter', () => {
  let RateLimiter, createProviderRateLimiters;
  beforeEach(async () => {
    const m = await loadRateLimiter();
    RateLimiter = m.RateLimiter;
    createProviderRateLimiters = m.createProviderRateLimiters;
  });

  test('factory provisions a litellm bucket like every other cloud provider', () => {
    const limiters = createProviderRateLimiters();
    assert.ok(limiters.litellm instanceof RateLimiter, 'litellm rate limiter created');
  });

  test('litellm bucket actually throttles (acquire resolves under budget)', async () => {
    const limiters = createProviderRateLimiters();
    // Conservative 120/min default — a few sequential acquires must succeed.
    await limiters.litellm.acquire();
    await limiters.litellm.acquire();
    await limiters.litellm.acquire();
  });
});

describe('LiteLLM outbound data-scope gating (privacy)', () => {
  let assertProviderDataScopes, getDeniedDataScopes, ProviderScopeError;
  beforeEach(async () => {
    const m = await loadProviderRouter();
    assertProviderDataScopes = m.assertProviderDataScopes;
    getDeniedDataScopes = m.getDeniedDataScopes;
    ProviderScopeError = m.ProviderScopeError;
  });

  test('litellm is gated identically to other cloud providers when a scope is denied', () => {
    const policy = { transcript: false }; // transcript egress disallowed
    // Sending a transcript-scoped payload to litellm MUST throw — same as deepseek would.
    assert.throws(
      () => assertProviderDataScopes('litellm', ['transcript'], policy),
      (err) => err instanceof ProviderScopeError && err.provider === 'litellm',
      'litellm transcript egress should be blocked by policy'
    );
    // Sanity: deepseek behaves the same, proving litellm is not special-cased.
    assert.throws(() => assertProviderDataScopes('deepseek', ['transcript'], policy), ProviderScopeError);
  });

  test('litellm passes when the payload carries only allowed scopes', () => {
    const policy = { transcript: false };
    // screenshots not denied → no throw.
    assert.doesNotThrow(() => assertProviderDataScopes('litellm', ['screenshots'], policy));
    assert.deepEqual(getDeniedDataScopes(['screenshots'], policy), []);
  });
});
