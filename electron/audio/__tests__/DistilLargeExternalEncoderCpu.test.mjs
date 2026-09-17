// Distil Large v2/v3 (and Whisper Large v3 Turbo) store fp32 encoder weights in
// a sibling encoder_model.onnx_data. Distil small.en does not — its encoder is
// inline (~353MB). The production log that motivated this:
//
//   distil-small.en  encoderBytes=352839390  providers=coreml,cpu  → transcribes
//   distil-large-v3  encoderBytes=646473     providers=coreml,cpu  → READY, no text
//
// ORT CoreML binds the 646KB graph stub and reports READY; inference then hangs
// or returns empty. Drop CoreML for encoder-external checkpoints. DirectML/CPU
// lists are unchanged (no 'coreml' to drop).
//
// Second guard: whisperWorker's transformers.js `pipe()` path did not serialize
// transcribe messages (Nemotron already does). dispatchFinal clears
// streamingTaskInFlight then posts another transcribe, so overlapping pipe()
// calls hit one ONNX session. Distil-large inference never completes under that.
//
// Run: electron --test electron/audio/__tests__/DistilLargeExternalEncoderCpu.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const inferenceSrc = fs.readFileSync(
  path.join(root, 'electron/audio/whisper/inferenceConfig.ts'),
  'utf8',
);
const workerSrc = fs.readFileSync(
  path.join(root, 'electron/audio/whisper/whisperWorker.ts'),
  'utf8',
);

function extractFunction(src, name) {
  const re = new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  assert.ok(m, `could not locate function ${name}`);
  let i = m.index + m[0].length;
  let depth = 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') depth--;
    i++;
  }
  while (i < src.length && src[i] !== '{') i++;
  assert.equal(src[i], '{', `${name} must have a function body`);
  const start = m.index;
  depth = 1;
  i++;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(start, i);
}

test('encoder-external checkpoints drop CoreML; inline-encoder Distil small does not', () => {
  const helper = extractFunction(inferenceSrc, 'dropCoremlForExternalEncoder');
  assert.match(
    helper,
    /encoder_model\.onnx/,
    'helper must key off the encoder_model.onnx external-data flag, not a bare true (Parakeet)',
  );
  assert.match(helper, /!== 'coreml'|!== \"coreml\"/);

  const build = extractFunction(inferenceSrc, 'buildWorkerInitMessage');
  assert.match(
    build,
    /dropCoremlForExternalEncoder\(\s*executionProviders\s*,\s*useExternalDataFormat\s*\)/,
    'buildWorkerInitMessage must route the non-Nemotron provider list through the helper',
  );
});

test('transformers.js pipe() transcribes are serialized on one chain', () => {
  assert.match(
    workerSrc,
    /let whisperPipeChain:\s*Promise<void>\s*=\s*Promise\.resolve\(\)/,
  );
  assert.match(
    workerSrc,
    /whisperPipeChain\s*=\s*whisperPipeChain\.then/,
    'overlapping pipe() transcribes (dispatchFinal vs streaming) must queue, not interleave',
  );
});
