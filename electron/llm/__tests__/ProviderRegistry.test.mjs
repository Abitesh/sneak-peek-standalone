// electron/llm/__tests__/ProviderRegistry.test.mjs
//
// Sprint S1 — Provider Registry pure helpers. `bindingFromModelId` /
// `providerFamilyFromBinding` / `filterChatCapable` / `filterVisionCapable`
// back the "model picker truth" fix (Problems 1-3, 11, 26): the picker and
// test-llm-connection must agree on what a verified, chat/vision-capable
// model actually is.
//
// Run: npm run build:electron, then node --test on this file.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  bindingFromModelId,
  providerFamilyFromBinding,
  filterChatCapable,
  filterVisionCapable,
} = await import(pathToFileURL(path.resolve(__dirname, '../../../dist-electron/electron/llm/providerRegistry.js')).href);

describe('bindingFromModelId', () => {
  test('defaults: chat true, streaming true, source preset, label = id', () => {
    const b = bindingFromModelId('gpt-4o', 'openai');
    assert.equal(b.id, 'gpt-4o');
    assert.equal(b.provider, 'openai');
    assert.equal(b.label, 'gpt-4o');
    assert.equal(b.capabilities.chat, true);
    assert.equal(b.capabilities.streaming, true);
    assert.equal(b.source, 'preset');
    assert.equal(typeof b.verifiedAt, 'number');
  });

  test('vision defaults from modelCapabilities — gpt-4o is vision-capable, a small Groq text model is not', () => {
    const visionBinding = bindingFromModelId('gpt-4o', 'openai');
    assert.equal(visionBinding.capabilities.vision, true);

    const textOnly = bindingFromModelId('llama-3.1-8b-instant', 'groq');
    assert.equal(textOnly.capabilities.vision, false);
  });

  test('an Ollama id is routed through the Ollama capability branch (isOllama=true)', () => {
    const b = bindingFromModelId('llava:7b', 'ollama');
    assert.equal(b.capabilities.vision, true, 'llava is a known vision-capable Ollama family');
  });

  test('explicit options override every inferred default', () => {
    const b = bindingFromModelId('custom-model', 'custom', {
      label: 'Custom Model',
      chatOk: false,
      visionOk: true,
      streamingOk: false,
      source: 'live-probe',
      contextWindow: 4096,
      maxOutputTokens: 512,
      lastError: 'boom',
      verifiedAt: 12345,
    });
    assert.deepEqual(b, {
      id: 'custom-model',
      provider: 'custom',
      label: 'Custom Model',
      capabilities: { chat: false, vision: true, streaming: false },
      contextWindow: 4096,
      maxOutputTokens: 512,
      source: 'live-probe',
      verifiedAt: 12345,
      lastError: 'boom',
    });
  });

  test('a probe-failed candidate (chatOk: false) never inherits the catalog default', () => {
    const b = bindingFromModelId('qwen/qwen3-32b', 'groq', { chatOk: false, lastError: 'Not available for this key/account' });
    assert.equal(b.capabilities.chat, false);
    assert.equal(b.lastError, 'Not available for this key/account');
  });
});

describe('providerFamilyFromBinding — defensive normalizer, not a plain field read', () => {
  test('a known family passes through unchanged', () => {
    for (const provider of ['gemini', 'groq', 'openai', 'claude', 'deepseek', 'nvidia_nim', 'litellm', 'ollama', 'codex-cli', 'custom']) {
      assert.equal(providerFamilyFromBinding({ provider }), provider);
    }
  });

  test('an unknown/stale provider id (e.g. from an older persisted binding) normalizes to custom', () => {
    assert.equal(providerFamilyFromBinding({ provider: 'natively' }), 'custom');
    assert.equal(providerFamilyFromBinding({ provider: 'retired-family' }), 'custom');
    assert.equal(providerFamilyFromBinding({}), 'custom');
  });
});

describe('filterChatCapable / filterVisionCapable', () => {
  const bindings = [
    bindingFromModelId('gpt-4o', 'openai', { chatOk: true }),
    bindingFromModelId('qwen/qwen3-32b', 'groq', { chatOk: false }),
    bindingFromModelId('claude-sonnet-4-6', 'claude', { chatOk: true, visionOk: false }),
  ];

  test('filterChatCapable keeps only capabilities.chat === true', () => {
    const chat = filterChatCapable(bindings);
    assert.deepEqual(chat.map((b) => b.id), ['gpt-4o', 'claude-sonnet-4-6']);
  });

  test('filterVisionCapable keeps only capabilities.vision === true', () => {
    const vision = filterVisionCapable(bindings);
    assert.deepEqual(vision.map((b) => b.id), ['gpt-4o']);
  });

  test('both are null-safe', () => {
    assert.deepEqual(filterChatCapable(undefined), []);
    assert.deepEqual(filterVisionCapable(null), []);
  });
});
