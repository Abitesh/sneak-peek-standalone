// electron/services/__tests__/OllamaHostAndCrossPlatform2026_08_31.test.mjs
//
// Sprint S5 (Problems 5, 21-22): Ollama's own daemon reads OLLAMA_HOST — the
// app previously understood only its own OLLAMA_URL, so setting the
// documented, cross-platform env var did nothing here. Also verifies
// LLMHelper.forceRestartOllama no longer shells out to Unix-only
// `lsof`/`kill -9` unconditionally — Windows has neither, so the port-kill
// step silently did nothing there (CLAUDE.md cross-platform contract).
//
// resolveDefaultOllamaUrl() is a pure function — tested directly against the
// compiled artifact. The forceRestartOllama Windows branch is verified by
// source inspection (it shells a real child process; a behavioral test would
// need a live Windows netstat/taskkill, which this environment can't provide).
//
// Run via: npm run build:electron && node --test electron/services/__tests__/OllamaHostAndCrossPlatform2026_08_31.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');

const OM_PATH = path.join(root, 'dist-electron/electron/services/OllamaManager.js');
const { resolveDefaultOllamaUrl } = require(OM_PATH);

describe('resolveDefaultOllamaUrl — OLLAMA_HOST precedence', () => {
  test('OLLAMA_HOST wins over the legacy OLLAMA_URL', () => {
    const url = resolveDefaultOllamaUrl({ OLLAMA_HOST: 'http://192.168.1.50:11434', OLLAMA_URL: 'http://localhost:9999' });
    assert.equal(url, 'http://192.168.1.50:11434');
  });

  test('a bare host:port OLLAMA_HOST (Ollama\'s own shorthand, no scheme) is normalized to http://', () => {
    assert.equal(resolveDefaultOllamaUrl({ OLLAMA_HOST: '0.0.0.0:11434' }), 'http://0.0.0.0:11434');
    assert.equal(resolveDefaultOllamaUrl({ OLLAMA_HOST: '127.0.0.1:11434' }), 'http://127.0.0.1:11434');
  });

  test('an OLLAMA_HOST with an explicit scheme is passed through unchanged', () => {
    assert.equal(resolveDefaultOllamaUrl({ OLLAMA_HOST: 'https://ollama.internal:443' }), 'https://ollama.internal:443');
  });

  test('falls back to legacy OLLAMA_URL when OLLAMA_HOST is unset', () => {
    assert.equal(resolveDefaultOllamaUrl({ OLLAMA_URL: 'http://localhost:4444' }), 'http://localhost:4444');
  });

  test('falls back to the hardcoded default when neither env var is set', () => {
    assert.equal(resolveDefaultOllamaUrl({}), 'http://127.0.0.1:11434');
  });

  test('empty-string env values are treated as unset, not as a literal empty host', () => {
    assert.equal(resolveDefaultOllamaUrl({ OLLAMA_HOST: '', OLLAMA_URL: '' }), 'http://127.0.0.1:11434');
  });

  test('this is the SAME resolver OllamaManager.probe()/runEnsure()/checkIsRunning() default to', () => {
    const src = fs.readFileSync(path.join(root, 'electron/services/OllamaManager.ts'), 'utf8');
    assert.match(src, /public async probe\(url: string = resolveDefaultOllamaUrl\(\)\)/);
    assert.match(src, /const url = options\.url \|\| resolveDefaultOllamaUrl\(\)/);
    assert.match(src, /private async checkIsRunning\(url: string = resolveDefaultOllamaUrl\(\)\)/);
  });
});

describe('LLMHelper.forceRestartOllama — cross-platform port-kill (source inspection)', () => {
  const src = fs.readFileSync(path.join(root, 'electron/LLMHelper.ts'), 'utf8');
  const start = src.indexOf('public async forceRestartOllama(');
  const end = src.indexOf('public hasConfiguredProvider(');
  const body = src.slice(start, end);

  test('the handler exists and this slice actually captured it', () => {
    assert.ok(start >= 0 && end > start, 'forceRestartOllama body should be extractable');
  });

  test('branches on process.platform — Windows gets its own path, not the Unix one silently no-op\'ing', () => {
    assert.match(body, /process\.platform === 'win32'/);
  });

  test('Windows path uses netstat/taskkill, never lsof/kill -9 (neither exists on Windows)', () => {
    const winBranch = body.slice(body.indexOf("'win32'"), body.indexOf('} else {'));
    assert.match(winBranch, /netstat -ano/);
    assert.match(winBranch, /taskkill \/F \/PID/);
    assert.doesNotMatch(winBranch, /lsof/);
    assert.doesNotMatch(winBranch, /kill -9/);
  });

  test('the non-Windows (macOS/Linux) path is preserved unchanged (lsof + kill -9)', () => {
    const unixBranch = body.slice(body.indexOf('} else {'));
    assert.match(unixBranch, /lsof -t -i:/);
    assert.match(unixBranch, /kill -9/);
  });

  test('the port is read from the configured Ollama URL, not hardcoded to 11434', () => {
    assert.match(body, /new URL\(this\.ollamaUrl\)\.port \|\| '11434'/);
  });
});
