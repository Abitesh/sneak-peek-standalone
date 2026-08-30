// electron/services/__tests__/ProviderHealthPersistence.test.mjs
//
// Sprint S1 — real persistence behavior for CredentialsManager.providerHealth,
// the store `test-llm-connection` (electron/ipcHandlers.ts) writes to so a
// probe's verified/disconnected/degraded verdict survives a restart instead
// of resetting to "just has a key" on every launch.
//
// Runs against the COMPILED dist-electron module with a mocked `electron`
// module and real disk I/O in a temp userData dir — same harness as
// CredentialPersistenceBehavior.test.mjs, extended with a provider-health
// round trip.
//
// Run via: npm run build:electron && node --test electron/services/__tests__/ProviderHealthPersistence.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const COMPILED = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../dist-electron/electron/services/CredentialsManager.js',
);

function makeEnv() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-provider-health-'));
  const state = { keyringAvailable: true, userData };
  const fakeElectron = {
    app: { getPath: () => state.userData, isPackaged: false, getVersion: () => '0.0.0-test' },
    safeStorage: {
      isEncryptionAvailable: () => state.keyringAvailable,
      encryptString: (s) => Buffer.concat([Buffer.from('KR'), Buffer.from(s, 'utf8')]),
      decryptString: (b) => Buffer.from(b).subarray(2).toString('utf8'),
      getSelectedStorageBackend: () => 'basic_text',
    },
  };
  return { state, fakeElectron, userData };
}

let CURRENT = null;
const origLoad = Module._load;
Module._load = function patched(request, _p, _m) {
  if (request === 'electron') {
    if (!CURRENT) throw new Error('no electron env active');
    return CURRENT.fakeElectron;
  }
  return origLoad.apply(this, arguments);
};

function freshManager(env) {
  CURRENT = env;
  delete require.cache[require.resolve(COMPILED)];
  const mod = require(COMPILED);
  if (mod.CredentialsManager.instance) mod.CredentialsManager.instance = undefined;
  delete globalThis.__nativelyCredentialsManagerV1__;
  const cm = mod.CredentialsManager.getInstance();
  cm.init();
  return cm;
}

const VERIFIED_HEALTH = {
  status: 'verified',
  authOk: true,
  lastProbeAt: 1700000000000,
  models: [
    {
      id: 'gpt-4o',
      provider: 'openai',
      label: 'gpt-4o',
      capabilities: { chat: true, vision: true, streaming: true },
      source: 'live-probe',
      verifiedAt: 1700000000000,
    },
  ],
};

const DISCONNECTED_HEALTH = {
  status: 'disconnected',
  authOk: false,
  lastProbeAt: 1700000001000,
  lastError: { code: 'INVALID_API_KEY', message: 'Invalid API key. Please check your credentials and try again.' },
  models: [],
};

test('missing providerHealth defaults to {} — backward compatible with pre-S1 credential files', () => {
  const cm = freshManager(makeEnv());
  assert.deepEqual(cm.getAllProviderHealth(), {});
  assert.equal(cm.getProviderHealth('openai'), undefined);
});

test('setProviderHealth persists and survives a restart (real disk round-trip)', () => {
  const env = makeEnv();
  const cm = freshManager(env);

  const persisted = cm.setProviderHealth('openai', VERIFIED_HEALTH);
  assert.equal(persisted, true, 'setter must report a successful write');

  const restarted = freshManager(env);
  assert.deepEqual(restarted.getProviderHealth('openai'), VERIFIED_HEALTH);
});

test('a disconnected (auth-failed) health entry is stored as-is — never silently upgraded or dropped', () => {
  const env = makeEnv();
  const cm = freshManager(env);
  cm.setProviderHealth('groq', DISCONNECTED_HEALTH);

  const restarted = freshManager(env);
  const health = restarted.getProviderHealth('groq');
  assert.equal(health.status, 'disconnected');
  assert.equal(health.authOk, false);
  assert.equal(health.lastError.code, 'INVALID_API_KEY');
});

test('each provider is independent — setting one never touches another\'s health', () => {
  const env = makeEnv();
  const cm = freshManager(env);
  cm.setProviderHealth('openai', VERIFIED_HEALTH);
  cm.setProviderHealth('groq', DISCONNECTED_HEALTH);

  assert.equal(cm.getProviderHealth('openai').status, 'verified');
  assert.equal(cm.getProviderHealth('groq').status, 'disconnected');
  assert.deepEqual(Object.keys(cm.getAllProviderHealth()).sort(), ['groq', 'openai']);
});

test('clearProviderHealth(provider) removes only that provider', () => {
  const env = makeEnv();
  const cm = freshManager(env);
  cm.setProviderHealth('openai', VERIFIED_HEALTH);
  cm.setProviderHealth('groq', DISCONNECTED_HEALTH);

  cm.clearProviderHealth('openai');
  assert.equal(cm.getProviderHealth('openai'), undefined);
  assert.equal(cm.getProviderHealth('groq').status, 'disconnected');
});

test('clearProviderHealth() with no argument clears every provider', () => {
  const env = makeEnv();
  const cm = freshManager(env);
  cm.setProviderHealth('openai', VERIFIED_HEALTH);
  cm.setProviderHealth('groq', DISCONNECTED_HEALTH);

  cm.clearProviderHealth();
  assert.deepEqual(cm.getAllProviderHealth(), {});
});
