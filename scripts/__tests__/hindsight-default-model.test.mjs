import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const scriptPath = path.resolve(process.cwd(), 'scripts/hindsight-dev-server.py');
const source = fs.readFileSync(scriptPath, 'utf8');

test('hindsight dev server defaults to the current Gemini Flash-Lite model', () => {
  assert.match(source, /MODEL = os\.environ\.get\("HINDSIGHT_LLM_MODEL", "gemini-3\.1-flash-lite"\)/,
    'The local Hindsight dev server should default to the current Gemini Flash-Lite model instead of a stale baseline.');
});
