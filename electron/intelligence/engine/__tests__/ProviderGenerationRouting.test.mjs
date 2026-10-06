import test from 'node:test';
import assert from 'node:assert/strict';
import { routeGenerationProviders } from '../../../llm/ProviderRouter.js';

test('generation routing honors an explicit preferred provider without semantic context decisions', () => {
  const attempts = routeGenerationProviders({
    capability: 'stream_chat',
    availability: { hasGroq: true, hasGemini: true },
    models: { groq: 'qwen/qwen3.8-27b', geminiFlash: 'gemini-3.7-flash' },
    preferredProvider: 'gemini_flash',
    maxAttempts: 2,
  });

  assert.deepEqual(attempts.map((a) => a.provider), ['gemini_flash', 'groq']);
  assert.equal(attempts[0].model, 'gemini-3.7-flash');
});

test('generation routing applies an explicit provider allow-list', () => {
  const attempts = routeGenerationProviders({
    capability: 'stream_chat',
    availability: { hasGroq: true, hasGemini: true },
    models: { groq: 'qwen/qwen3.8-27b', geminiFlash: 'gemini-3.7-flash' },
    allowedProviders: ['gemini_flash'],
  });

  assert.deepEqual(attempts.map((a) => a.provider), ['gemini_flash']);
});
