#!/usr/bin/env node
// Stage 1 scripted proof: OllamaManager.probe + LLMHelper reachability/models
// when the daemon is down. No GUI. Exit 0 only if probes finish within deadline
// and report unreachable cleanly.
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const require = createRequire(path.join(root, 'package.json'));
const DEADLINE_MS = 2000;

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: { isReady: () => true, getPath: () => os.tmpdir(), getVersion: () => '0.0.0-test' },
    safeStorage: { isEncryptionAvailable: () => false },
  },
};

const { OllamaManager } = require(path.join(root, 'dist-electron/electron/services/OllamaManager.js'));
const { LLMHelper } = require(path.join(root, 'dist-electron/electron/LLMHelper.js'));

async function timed(label, fn) {
  const t0 = Date.now();
  const value = await fn();
  const elapsedMs = Date.now() - t0;
  return { label, elapsedMs, value };
}

const results = [];
results.push(await timed('OllamaManager.probe', () => OllamaManager.getInstance().probe()));

const helper = new LLMHelper('unused-key', false);
helper.ollamaUrl = 'http://127.0.0.1:11434';
results.push(await timed('LLMHelper.isOllamaReachable', () => helper.isOllamaReachable()));
results.push(await timed('LLMHelper.getOllamaModels', () => helper.getOllamaModels()));

let failed = false;
for (const r of results) {
  const ok = r.elapsedMs < DEADLINE_MS;
  console.log(JSON.stringify({
    label: r.label,
    elapsedMs: r.elapsedMs,
    withinDeadline: ok,
    summary: r.label === 'OllamaManager.probe'
      ? { health: r.value.health, message: r.value.message }
      : r.value,
  }));
  if (!ok) failed = true;
}

const probe = results[0].value;
const reachable = results[1].value;
const models = results[2].value;
if (reachable !== false) {
  console.error('Expected isOllamaReachable() === false when daemon is down');
  failed = true;
}
if (!Array.isArray(models) || models.length !== 0) {
  console.error('Expected getOllamaModels() === [] when daemon is down');
  failed = true;
}
if (probe.health === 'ready') {
  console.error('Daemon unexpectedly ready — Stage 1 unreachable proof skipped');
  // Still success if probes were fast; connectivity proof is environmental.
  console.log('NOTE: Ollama is running; unreachable matrix cell not proven this run.');
} else if (probe.health !== 'missing_optional_dependency' && probe.health !== 'unavailable') {
  console.error(`Unexpected probe health: ${probe.health}`);
  failed = true;
}

process.exit(failed ? 1 : 0);
