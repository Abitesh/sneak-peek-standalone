/**
 * Stage 7: Moonshine streaming profile retuned from 750/400 → 400/400 after
 * docs/ASR_MODEL_BENCHMARK.md showed the 750 ms poll gate dominated
 * measured partial inference (~280–400 ms on Apple M3).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.resolve(__dirname, '../LocalWhisperSTT.ts'), 'utf8');

test('moonshine streaming profile uses 400/400 after Stage 7 bench', () => {
  const idx = src.indexOf("includes('moonshine')");
  assert.ok(idx > 0, 'expected moonshine branch in resolveStreamingProfile');
  const branch = src.slice(idx, idx + 280);
  assert.match(
    branch,
    /intervalMs:\s*400/,
    'moonshine intervalMs must be 400 (750 dominated measured inference)',
  );
  assert.match(
    branch,
    /minAudioMs:\s*400/,
    'moonshine minAudioMs must stay 400',
  );
  assert.doesNotMatch(
    branch,
    /intervalMs:\s*750/,
    'moonshine must not keep the pre-bench 750 ms interval',
  );
});
