// Unit tests for scripts/download-models.js skip / CI soft-fail policy.
// Pure decision helpers only — no network, no onnxruntime.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  REQUIRED_MODEL_FILES,
  shouldSkipModelDownload,
  resolvePostWorkerOutcome,
  isCiEnv,
  isSkipModelDownload,
} = require('../download-models.js');

function seedModelsDir(root) {
  for (const rel of REQUIRED_MODEL_FILES) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x');
  }
}

describe('isCiEnv / isSkipModelDownload', () => {
  test('CI=true and CI=1 count as CI', () => {
    assert.equal(isCiEnv({ CI: 'true' }), true);
    assert.equal(isCiEnv({ CI: '1' }), true);
    assert.equal(isCiEnv({}), false);
  });

  test('NATIVELY_SKIP_MODEL_DOWNLOAD=1 is the explicit escape hatch', () => {
    assert.equal(isSkipModelDownload({ NATIVELY_SKIP_MODEL_DOWNLOAD: '1' }), true);
    assert.equal(isSkipModelDownload({}), false);
  });
});

describe('shouldSkipModelDownload', () => {
  test('skips when NATIVELY_SKIP_MODEL_DOWNLOAD=1 even if models are missing', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-skip-'));
    const d = shouldSkipModelDownload({ NATIVELY_SKIP_MODEL_DOWNLOAD: '1' }, empty);
    assert.equal(d.skip, true);
    assert.match(d.reason, /NATIVELY_SKIP_MODEL_DOWNLOAD/);
  });

  test('skips when required model files are already on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-present-'));
    seedModelsDir(dir);
    const d = shouldSkipModelDownload({}, dir);
    assert.equal(d.skip, true);
    assert.match(d.reason, /already present/);
  });

  test('does not skip on a bare CI flag when models are missing (download still needed)', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-ci-'));
    const d = shouldSkipModelDownload({ CI: 'true' }, empty);
    assert.equal(d.skip, false);
  });
});

describe('resolvePostWorkerOutcome', () => {
  test('SIGABRT / exit 134 after a successful download is success when files exist', () => {
    const a = resolvePostWorkerOutcome({ status: null, signal: 'SIGABRT', modelsPresent: true });
    assert.equal(a.exitCode, 0);
    assert.match(a.message, /aborted/);

    const b = resolvePostWorkerOutcome({ status: 134, signal: null, modelsPresent: true });
    assert.equal(b.exitCode, 0);
  });

  test('clean worker success with models present is success', () => {
    const o = resolvePostWorkerOutcome({ status: 0, signal: null, modelsPresent: true });
    assert.equal(o.exitCode, 0);
  });

  test('CI soft-fails when the worker dies and models are still missing', () => {
    const o = resolvePostWorkerOutcome({
      status: 134,
      signal: 'SIGABRT',
      modelsPresent: false,
      env: { CI: 'true' },
    });
    assert.equal(o.exitCode, 0);
    assert.match(o.message, /soft-fail/);
  });

  test('local (non-CI) failure with missing models stays hard-fail', () => {
    const o = resolvePostWorkerOutcome({
      status: 1,
      signal: null,
      modelsPresent: false,
      env: {},
    });
    assert.equal(o.exitCode, 1);
  });
});
