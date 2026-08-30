// electron/services/__tests__/TestOllamaConnectionHealthWiring2026_08_31.test.mjs
//
// Sprint S5 (Problems 5, 21-25): `test-ollama-connection` gives Ollama the
// same real-verification treatment as test-llm-connection/
// test-litellm-connection — reachability, THEN /api/tags, THEN a minimal
// chat probe — and persists the verdict as a ProviderHealth so Ollama
// participates in the same registry the cloud providers and LiteLLM do
// (forward-compat for whatever eventually reads providerHealth for
// fallback routing).
//
// Source-inspection style — see TestLlmConnectionHealthWiring2026_08_31 for
// rationale (the handler is a closure inside setupIpcHandlers(), not
// standalone-instantiable).
//
// Run via: npm run build:electron && node --test electron/services/__tests__/TestOllamaConnectionHealthWiring2026_08_31.test.mjs

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
  const start = src.indexOf("safeHandle('test-ollama-connection'");
  assert.ok(start >= 0, 'test-ollama-connection handler should exist');
  const end = src.indexOf("safeHandle('switch-to-ollama'", start);
  assert.ok(end > start, 'the handler should be followed by switch-to-ollama');
  return src.slice(start, end);
}

describe('test-ollama-connection wiring', () => {
  test('reachability is checked FIRST — before any model list or chat probe', () => {
    const body = handlerSource();
    const reachableAt = body.indexOf('isOllamaReachable()');
    const tagsAt = body.indexOf('getOllamaModels()');
    const chatAt = body.indexOf('/api/chat`');
    assert.ok(reachableAt >= 0 && tagsAt >= 0 && chatAt >= 0);
    assert.ok(reachableAt < tagsAt, 'reachability must be checked before listing models');
    assert.ok(tagsAt < chatAt, 'models must be listed before the chat probe');
  });

  test('unreachable persists as disconnected + authOk:false, distinct from "no models"', () => {
    const body = handlerSource();
    assert.match(body, /if \(!reachable\)/);
    const disconnectedAt = body.indexOf("status: 'disconnected'");
    assert.ok(disconnectedAt >= 0);
    assert.match(body.slice(disconnectedAt - 200, disconnectedAt + 200), /authOk: false/);
    assert.match(body, /OLLAMA_UNREACHABLE/);
  });

  test('reachable + zero models is degraded (not disconnected) — the daemon works, nothing is pulled yet', () => {
    const body = handlerSource();
    assert.match(body, /if \(names\.length === 0\)/);
    const noModelsAt = body.indexOf('NO_MODELS');
    assert.ok(noModelsAt >= 0);
    const nearby = body.slice(noModelsAt - 200, noModelsAt + 50);
    assert.match(nearby, /status: 'degraded'/);
  });

  test('the chat probe hits exactly ONE candidate, never the whole catalogue (cold-load cost)', () => {
    const body = handlerSource();
    assert.match(body, /const candidate = names\[0\]/);
    assert.doesNotMatch(body, /for \(const candidate of names\)/);
  });

  test('registered bindings use the ollama-<name> id convention, matching every other ollama-* surface', () => {
    const body = handlerSource();
    assert.match(body, /id: `ollama-\$\{name\}`/);
  });

  test('every branch persists via CredentialsManager.setProviderHealth for the ollama family', () => {
    const body = handlerSource();
    const calls = body.match(/creds\.setProviderHealth\('ollama', health\)/g) || [];
    assert.ok(calls.length >= 3, `expected setProviderHealth on unreachable, no-models, and probed paths, found ${calls.length}`);
  });

  test('this probe never spawns or restarts the daemon — no useOllama selection gate', () => {
    const body = handlerSource();
    assert.doesNotMatch(body, /isUsingOllama\(\)/, 'test-ollama-connection must stay read-only/opportunistic, unlike ensure-ollama-running');
    assert.doesNotMatch(body, /OllamaManager/, 'must not reach into OllamaManager to start/restart anything');
  });
});

describe('AIProvidersSettings — checkOllamaInner uses reachability FIRST (Problem 5, 21)', () => {
  const settings = read('src/components/settings/AIProvidersSettings.tsx');
  const start = settings.indexOf('const checkOllamaInner = async () => {');
  const end = settings.indexOf('const handleFixOllama = async () => {');
  const body = settings.slice(start, end);

  test('isOllamaReachable is awaited before getAvailableOllamaModels — a daemon down never falls through to the model-list branch', () => {
    const reachableAt = body.indexOf('isOllamaReachable?.()');
    const modelsAt = body.indexOf('getAvailableOllamaModels?.()');
    assert.ok(reachableAt >= 0 && modelsAt >= 0);
    assert.ok(reachableAt < modelsAt);
  });

  test('an empty model list on a REACHABLE daemon still sets \'detected\' — not the old "empty list -> not-found" bug', () => {
    assert.doesNotMatch(
      body,
      /if \(models && models\.length > 0\)/,
      'the old length-gated detected assignment must be gone',
    );
    assert.match(body, /setOllamaStatus\('detected'\);/);
  });

  test('a probe (test-ollama-connection) registers providerHealth once the model set is known, throttled by a ref so it does not re-fire every 3s poll', () => {
    assert.match(body, /ollamaHealthProbedRef/);
    assert.match(body, /testOllamaConnection\?\.\(\)/);
  });
});

describe('AIProvidersSettings — handleFixOllama gives actionable results (Problem 23)', () => {
  const settings = read('src/components/settings/AIProvidersSettings.tsx');
  const start = settings.indexOf('const handleFixOllama = async () => {');
  const end = settings.indexOf('const saveCodexCliConfig');
  const body = settings.slice(start, end);

  test('uses ensure-ollama-running (which returns the full ProviderStatus), not the bare-boolean force-restart-ollama', () => {
    assert.match(body, /'ensure-ollama-running'/);
  });

  test('distinguishes "not selected" from a genuine start failure with different messages', () => {
    assert.match(body, /reason === 'ollama-not-selected'/);
    assert.match(body, /Select Ollama as your Active Model/);
  });

  test('an ENOENT (binary not on PATH) start failure reports "not installed", not the generic not-detected copy', () => {
    assert.match(body, /errorCode === 'ENOENT'/);
    assert.match(body, /not installed/);
  });

  test('re-checks reachability before restarting — never force-restarts an already-healthy daemon', () => {
    assert.match(body, /const reachable = await window\.electronAPI\?\.isOllamaReachable\?\.\(\)/);
    assert.match(body, /if \(reachable\)/);
  });
});
