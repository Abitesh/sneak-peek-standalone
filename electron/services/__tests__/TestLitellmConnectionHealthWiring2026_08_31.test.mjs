// electron/services/__tests__/TestLitellmConnectionHealthWiring2026_08_31.test.mjs
//
// Sprint S4 (Problem 20): `test-litellm-connection` must do real verification
// for the LiteLLM proxy — reachability + auth, THEN a model list, THEN a chat
// probe — and persist the verdict as a ProviderHealth, the same shape
// test-llm-connection uses for the 6 cloud providers. A proxy that is merely
// unreachable, or that rejects the virtual key, must never render as
// "provider disabled".
//
// Source-inspection style, matching TestLlmConnectionHealthWiring2026_08_31 /
// ProviderVisibilityFilters: the handler is a closure registered inside
// setupIpcHandlers() and depends on the whole Electron/AppState graph, so it
// can't be instantiated standalone here. The invariants that matter are
// structural — ordering, which branch sets which status, and that
// persistence actually happens.
//
// Run via: npm run build:electron && node --test electron/services/__tests__/TestLitellmConnectionHealthWiring2026_08_31.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const IPC = 'electron/ipcHandlers.ts';

function handlerSource() {
  const src = read(IPC);
  const start = src.indexOf("safeHandle('test-litellm-connection'");
  assert.ok(start >= 0, 'test-litellm-connection handler should exist');
  const end = src.indexOf("safeHandle('get-disabled-providers'", start);
  assert.ok(end > start, 'the handler should be followed by get-disabled-providers');
  return src.slice(start, end);
}

describe('test-litellm-connection wiring', () => {
  test('reachability/auth failure (no baseURL, or the /models fetch fails) persists as disconnected + authOk:false', () => {
    const body = handlerSource();
    assert.match(body, /if \(!baseURL\)/, 'must guard on no proxy configured');
    const disconnectedAt = body.indexOf("status: 'disconnected'");
    assert.ok(disconnectedAt >= 0);
    assert.match(body.slice(disconnectedAt - 200, disconnectedAt + 200), /authOk: false/);
  });

  test('the model list and the chat probe are two distinct steps, in that order', () => {
    const body = handlerSource();
    const listAt = body.indexOf('/models`');
    const probeAt = body.indexOf('/chat/completions`');
    assert.ok(listAt >= 0 && probeAt >= 0, 'both the list and chat-probe requests should exist');
    assert.ok(listAt < probeAt, 'the model list must be fetched before the chat probe');
  });

  test('a chat-probe failure after a successful list is degraded, not disconnected — the proxy is not blamed for one bad model', () => {
    const body = handlerSource();
    assert.match(body, /status: 'degraded'/);
    const degradedAt = body.indexOf("status: 'degraded'");
    const nearby = body.slice(degradedAt - 300, degradedAt + 300);
    assert.match(nearby, /authOk: true/, 'degraded must still report authOk:true — the proxy is reachable');
  });

  test('errors are normalized via a LiteLLM-specific normalizer, not raw fetch/axios messages', () => {
    const body = handlerSource();
    assert.match(body, /normalizeLitellmError\('list', resp\.status, null\)/);
    assert.match(body, /normalizeLitellmError\('list', undefined, error\)/);
    assert.match(body, /normalizeLitellmError\('chat', probeStatus, probeErr\)/);
  });

  test('every branch persists via CredentialsManager.setProviderHealth for the litellm family', () => {
    const body = handlerSource();
    const calls = body.match(/creds\.setProviderHealth\('litellm', health\)/g) || [];
    assert.ok(calls.length >= 3, `expected setProviderHealth on the unreachable, list-failure, and success paths, found ${calls.length}`);
  });

  test('a successful probe registers litellm/-prefixed bindings, matching the model picker\'s id convention', () => {
    const body = handlerSource();
    assert.match(body, /id: `litellm\/\$\{id\}`/);
  });

  test('the response returns models + health alongside success (renderer picker truth)', () => {
    const body = handlerSource();
    assert.match(body, /return \{ success: true, models: fetchedIds\.map/);
  });
});

describe('normalizeLitellmError — distinct category set from provider-disabled', () => {
  const src = read(IPC);
  const start = src.indexOf('function normalizeLitellmError');
  const end = src.indexOf("safeHandle('test-litellm-connection'", start);
  const body = src.slice(start, end);

  test('the normalizer exists and distinguishes unreachable / auth / server-error / unknown', () => {
    assert.ok(start >= 0 && end > start, 'normalizeLitellmError should exist, before the handler that uses it');
    assert.match(body, /PROXY_UNREACHABLE/);
    assert.match(body, /INVALID_API_KEY/);
    assert.match(body, /PROXY_ERROR/);
    assert.match(body, /UNKNOWN_ERROR/);
  });

  test('never returns a "disabled"-shaped category — that is a distinct, user-initiated state', () => {
    assert.doesNotMatch(body, /disabled/i);
  });
});

describe('resolveLitellmMaxTokens — UI max-tokens setting reaches every LiteLLM chat call (Problem 20)', () => {
  const llm = read('electron/LLMHelper.ts');

  test('both the streaming and non-streaming LiteLLM paths resolve max_tokens per-request, not a stale constant', () => {
    const streamStart = llm.indexOf('private async * streamWithLiteLLM(');
    const streamEnd = llm.indexOf('private async * streamWithNvidiaNim(');
    const genStart = llm.indexOf('private async generateWithLiteLLM(');
    const genEnd = llm.indexOf('private async generateWithNvidiaNim(');
    assert.ok(streamStart >= 0 && streamEnd > streamStart, 'streamWithLiteLLM should exist');
    assert.ok(genStart >= 0 && genEnd > genStart, 'generateWithLiteLLM should exist');
    assert.match(llm.slice(streamStart, streamEnd), /await this\.resolveLitellmMaxTokens\(litellmModel\)/);
    assert.match(llm.slice(genStart, genEnd), /await this\.resolveLitellmMaxTokens\(litellmModel\)/);
  });

  test('the manual UI override (litellmMaxTokens) wins; otherwise the live /model/info budget is used', () => {
    const start = llm.indexOf('private async resolveLitellmMaxTokens(');
    const end = llm.indexOf('public setNativelyKey(');
    const body = llm.slice(start, end);
    assert.match(body, /if \(this\.litellmMaxTokens !== null\) return this\.litellmMaxTokens/, 'manual override must short-circuit before any network call');
    assert.match(body, /await this\.refreshLitellmModelBudgets\(\)/, 'Auto mode must consult the live per-model budget cache');
  });

  test('setLitellmConfig (the Settings Save path) is what stores the manual override resolveLitellmMaxTokens reads', () => {
    const start = llm.indexOf('public setLitellmConfig(');
    const end = llm.indexOf('private async refreshLitellmModelBudgets(');
    const body = llm.slice(start, end);
    assert.match(body, /this\.litellmMaxTokens = \(Number\.isFinite\(n\) && n > 0\)/);
  });

  test('boot (ProcessingHelper) re-applies the stored maxTokens on startup, not just on a Settings save', () => {
    const ph = read('electron/ProcessingHelper.ts');
    assert.match(ph, /setLitellmConfig\(credManager\.getLitellmApiKey\(\) \|\| '', litellmBaseURL, credManager\.getLitellmMaxTokens\(\)\)/);
  });
});

describe('LiteLLM Settings UI — Test Connection button + status badge (Problem 20)', () => {
  const settings = read('src/components/settings/AIProvidersSettings.tsx');

  test('handleTestLitellmConnection calls the new IPC bridge and stores health under the litellm key', () => {
    const start = settings.indexOf('const handleTestLitellmConnection');
    assert.ok(start >= 0, 'handleTestLitellmConnection should exist');
    const body = settings.slice(start, start + 1200);
    assert.match(body, /testLitellmConnection\?\.\(/);
    assert.match(body, /setProviderHealth\(prev => \(\{ \.\.\.prev, litellm: result\.health/);
  });

  test('a Save re-verifies the proxy immediately, mirroring handleSaveKey for cloud providers', () => {
    const saveStart = settings.indexOf('const handleSaveLitellm');
    const saveEnd = settings.indexOf('const handleRemoveLitellm');
    const body = settings.slice(saveStart, saveEnd);
    assert.match(body, /handleTestLitellmConnection\(\)\.catch/);
  });

  test('the card renders Verified/Disconnected/Degraded from providerHealth.litellm, not just "Configured"', () => {
    const cardStart = settings.indexOf("providerHealth.litellm?.status === 'verified'");
    assert.ok(cardStart >= 0, 'the LiteLLM card should branch on providerHealth.litellm.status');
    const body = settings.slice(cardStart, cardStart + 600);
    assert.match(body, /'disconnected'/);
    assert.match(body, /'degraded'/);
  });
});
