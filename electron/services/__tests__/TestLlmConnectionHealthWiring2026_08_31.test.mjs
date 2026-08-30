// electron/services/__tests__/TestLlmConnectionHealthWiring2026_08_31.test.mjs
//
// Sprint S1 (Problems 2, 26): `test-llm-connection` must do real verification
// — auth, THEN a model list, THEN a chat probe — and persist the verdict as a
// ProviderHealth via CredentialsManager, never conflating an auth failure
// with "provider disabled".
//
// Source-inspection style, matching ProviderVisibilityFilters.test.mjs:
// ipcHandlers' handler is a closure registered inside setupIpcHandlers() and
// depends on the whole Electron/AppState graph, so it can't be instantiated
// standalone here. The invariants that matter are structural — ordering,
// which branch sets which `status`, and that persistence actually happens —
// and those are exactly what source inspection can pin.
//
// Run via: npm run build:electron && node --test electron/services/__tests__/TestLlmConnectionHealthWiring2026_08_31.test.mjs

import { test } from 'node:test';
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
  const start = src.indexOf("    'test-llm-connection',");
  assert.ok(start >= 0, 'test-llm-connection handler should exist');
  const end = src.indexOf("  safeHandle('get-provider-health'", start);
  assert.ok(end > start, 'the handler should be followed by get-provider-health');
  return src.slice(start, end);
}

test('auth/model-list failure persists as disconnected + authOk:false, never as disabled', () => {
  const body = handlerSource();
  const fetchAt = body.indexOf('fetchProviderModels(provider, apiKey)');
  const disconnectedAt = body.indexOf("status: 'disconnected'");
  assert.ok(fetchAt >= 0, 'must call fetchProviderModels to authenticate + list models');
  assert.ok(disconnectedAt > fetchAt, 'disconnected status must be assigned in the catch of the list-fetch, after the call');
  assert.match(body, /authOk: false/, 'a list-fetch failure must record authOk:false');
  assert.doesNotMatch(
    body.slice(disconnectedAt - 400, disconnectedAt + 400),
    /disabledProviders/,
    'the disconnected branch must not reference disabledProviders — auth failure is never "provider disabled"',
  );
});

test('the list fetch and the chat probe are two distinct steps, in that order', () => {
  const body = handlerSource();
  const listAt = body.indexOf('fetchProviderModels(provider, apiKey)');
  const probeAt = body.indexOf('probeChatModel(provider, apiKey, candidate)');
  assert.ok(listAt >= 0 && probeAt >= 0);
  assert.ok(listAt < probeAt, 'auth/list must happen before the chat probe');
});

test('a probe failure after successful auth is degraded, not disconnected — key is not blamed for a bad model id', () => {
  const body = handlerSource();
  assert.match(body, /status: 'degraded'/);
  const degradedAt = body.indexOf("status: 'degraded'");
  const nearby = body.slice(degradedAt - 300, degradedAt + 300);
  assert.match(nearby, /authOk: true/, 'degraded must still report authOk:true — the key works');
});

test('every branch persists via CredentialsManager.setProviderHealth', () => {
  const body = handlerSource();
  const calls = body.match(/creds\.setProviderHealth\(provider, health\)/g) || [];
  assert.ok(calls.length >= 2, `expected setProviderHealth on both the auth-failure and success paths, found ${calls.length}`);
});

test('the response returns models + health alongside success/error (renderer picker truth)', () => {
  const body = handlerSource();
  assert.match(body, /return \{ success: false, error: sanitizeErrorMessage\(normalized\.message\), health \};/);
  assert.match(body, /return \{ success: true, models: fetched, health \};/);
});

test('errors are normalized via ProviderErrorNormalizer, not raw axios messages', () => {
  const body = handlerSource();
  assert.match(body, /normalizeProviderError\(provider, error\)/);
  assert.match(body, /normalizeProviderError\(provider, probeError\)/);
});

test('a model-gone probe failure advances to the next candidate; other failures (auth/rate-limit) do not', () => {
  const body = handlerSource();
  assert.match(body, /if \(!isProbeModelGone\(provider, err\)\) break;/);
});

test('get-provider-health reads from CredentialsManager, not a fresh/empty object', () => {
  const src = read(IPC);
  const start = src.indexOf("safeHandle('get-provider-health'");
  assert.ok(start >= 0, 'get-provider-health handler should exist');
  const body = src.slice(start, start + 300);
  assert.match(body, /getAllProviderHealth\(\)/);
});
