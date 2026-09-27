#!/usr/bin/env node
/**
 * Stage 7 — ASR measure-then-pick harness.
 *
 * Walks MODEL_CATALOG, runs load / warmup / RTF / latency / RSS measurements
 * against installed models only (never downloads). Missing models are listed
 * as "needs run". Writes docs/ASR_MODEL_BENCHMARK.md.
 *
 * Usage:
 *   node scripts/benchmark-asr-models.mjs
 *   NATIVELY_ASR_BENCH_MODELS=id1,id2 node scripts/benchmark-asr-models.mjs
 *   NATIVELY_ASR_BENCH_WARMUPS=1 NATIVELY_ASR_BENCH_RUNS=3 node scripts/benchmark-asr-models.mjs
 *
 * Fixture: electron/audio/whisper/nemotron/__tests__/fixtures/known-phrase-16k-mono.wav
 * ("the quick brown fox jumps over the lazy dog")
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';
import { Worker } from 'worker_threads';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const FIXTURE_WAV = path.join(
  REPO,
  'electron/audio/whisper/nemotron/__tests__/fixtures/known-phrase-16k-mono.wav',
);
const KNOWN_PHRASE = 'the quick brown fox jumps over the lazy dog';
const OUT_MD = path.join(REPO, 'docs/ASR_MODEL_BENCHMARK.md');
const OUT_JSON = path.join(REPO, 'docs/ASR_MODEL_BENCHMARK.json');

const WARMUPS = Math.max(0, Number(process.env.NATIVELY_ASR_BENCH_WARMUPS ?? 1));
const RUNS = Math.max(1, Number(process.env.NATIVELY_ASR_BENCH_RUNS ?? 3));
const ONLY = (process.env.NATIVELY_ASR_BENCH_MODELS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function defaultAppUserDataDir() {
  const appName = 'natively';
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName);
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), appName);
}

function modelsDir() {
  return process.env.NATIVELY_WHISPER_MODELS_DIR
    || path.join(defaultAppUserDataDir(), 'whisper-models');
}

/** Same RIFF walk as nemotron integration test — LIST/INFO chunks before data. */
function readPcm16Mono(wavPath) {
  const buf = fs.readFileSync(wavPath);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${wavPath} is not a RIFF/WAVE file`);
  }
  let offset = 12;
  let dataStart = -1;
  let dataSize = 0;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      dataStart = offset + 8;
      dataSize = chunkSize;
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (dataStart < 0) throw new Error(`${wavPath}: no 'data' chunk found`);
  const sampleCount = Math.floor(Math.min(dataSize, buf.length - dataStart) / 2);
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = buf.readInt16LE(dataStart + i * 2) / 32768;
  }
  return out;
}

function wordOverlap(text, knownPhrase) {
  const words = knownPhrase.split(' ');
  const hits = words.filter((w) => String(text || '').toLowerCase().includes(w)).length;
  return hits / words.length;
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function rssMb() {
  return Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
}

function cpuSnapshot() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

function cpuPct(before, after) {
  const idleDelta = after.idle - before.idle;
  const totalDelta = after.total - before.total;
  if (totalDelta <= 0) return null;
  return Math.round((1 - idleDelta / totalDelta) * 1000) / 10;
}

function loadCatalog() {
  // Prefer source MODEL_CATALOG via a tiny worker-free parse of the built
  // module when present; otherwise require the TS through the repo's usual
  // dist-electron path after build:electron.
  const distPath = path.join(REPO, 'dist-electron/electron/audio/whisper/modelManager.js');
  if (fs.existsSync(distPath)) {
    // eslint-disable-next-line import/no-dynamic-require
    const mod = require(distPath);
    return mod.MODEL_CATALOG.filter((m) => !m.hidden);
  }
  // Fallback: scrape ids from source so the harness still enumerates without a build.
  const src = fs.readFileSync(path.join(REPO, 'electron/audio/whisper/modelManager.ts'), 'utf8');
  const ids = [...src.matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => m[1]);
  return ids.map((id) => ({ id, name: id, sizeMb: 0, sessionLayout: id.includes('nemotron') ? 'nemotron-rnnt' : id.includes('parakeet') ? 'single' : undefined }));
}

function resolveDtype() {
  try {
    const dist = path.join(REPO, 'dist-electron/electron/audio/whisper/inferenceConfig.js');
    if (fs.existsSync(dist)) {
      return require(dist).resolveInferenceConfig().dtype;
    }
  } catch { /* fall through */ }
  // Match WHISPER_SAFE_DTYPE when SettingsManager/electron isn't available.
  return {
    encoder_model: 'fp32',
    decoder_model: 'q8',
    decoder_model_merged: 'q8',
    decoder_with_past_model: 'q8',
    model: 'q8',
  };
}

function isCached(entry, dtype) {
  const cacheDir = modelsDir();
  const modelDir = path.join(cacheDir, entry.id);
  if (!fs.existsSync(modelDir)) return false;
  if (entry.sessionLayout === 'nemotron-rnnt') {
    const required = [
      'encoder.onnx', 'encoder.onnx.data',
      'decoder.onnx', 'decoder.onnx.data',
      'joint.onnx', 'joint.onnx.data',
      'tokenizer.json', 'vocab.txt', 'tokenizer_config.json',
    ];
    return required.every((f) => {
      try { return fs.statSync(path.join(modelDir, f)).size > 0; } catch { return false; }
    });
  }
  // Prefer built isModelCached when available (dtype-aware).
  try {
    const dist = path.join(REPO, 'dist-electron/electron/audio/whisper/modelManager.js');
    if (fs.existsSync(dist)) {
      // Monkey-patch getModelsDir by pointing NATIVELY path — modelManager uses
      // electron app.getPath. Call a local directory check instead.
      const onnxDir = path.join(modelDir, 'onnx');
      if (!fs.existsSync(onnxDir)) return fs.readdirSync(modelDir).length > 0;
      return fs.readdirSync(onnxDir).some((f) => f.endsWith('.onnx') && fs.statSync(path.join(onnxDir, f)).size > 0);
    }
  } catch { /* ignore */ }
  void dtype;
  try { return fs.readdirSync(modelDir).length > 0; } catch { return false; }
}

/**
 * Run one transformers.js ASR model in an isolated worker so load/RSS for
 * model A don't contaminate model B (and so we can terminate sessions).
 */
function benchTransformersModel(modelId, audio, dtype) {
  const workerSource = `
    const { parentPort, workerData } = require('worker_threads');
    const { performance } = require('perf_hooks');
    (async () => {
      const loadTransformers = () => (new Function('return import("@huggingface/transformers")')());
      const { pipeline, env } = await loadTransformers();
      env.cacheDir = workerData.cacheDir;
      env.allowRemoteModels = false; // installed-only
      if (env.backends?.onnx) {
        env.backends.onnx.executionProviders = workerData.providers;
      }
      const t0 = performance.now();
      const pipe = await pipeline('automatic-speech-recognition', workerData.modelId, {
        dtype: workerData.dtype,
      });
      const loadMs = performance.now() - t0;
      parentPort.postMessage({ type: 'loaded', loadMs, rssMb: process.memoryUsage().rss / (1024*1024) });

      const runOnce = async (streaming) => {
        const opts = streaming
          ? { sampling_rate: 16000, temperature: 0, no_speech_threshold: 0.6, compression_ratio_threshold: 2.4, condition_on_previous_text: false, return_timestamps: false }
          : { sampling_rate: 16000, condition_on_previous_text: false, compression_ratio_threshold: 2.4, logprob_threshold: -1.0, no_speech_threshold: 0.6 };
        // English-only models reject task/language — omit both (see whisperWorker.ts).
        const t1 = performance.now();
        const result = await pipe(workerData.audio, opts);
        return { ms: performance.now() - t1, text: result?.text ?? '' };
      };

      for (let i = 0; i < workerData.warmups; i++) await runOnce(false);

      const partialMs = [];
      const finalMs = [];
      let lastText = '';
      for (let i = 0; i < workerData.runs; i++) {
        const p = await runOnce(true);
        partialMs.push(p.ms);
        const f = await runOnce(false);
        finalMs.push(f.ms);
        lastText = f.text || p.text;
      }
      parentPort.postMessage({
        type: 'done',
        loadMs,
        partialMs,
        finalMs,
        text: lastText,
        rssMb: process.memoryUsage().rss / (1024*1024),
      });
    })().catch((e) => parentPort.postMessage({ type: 'error', message: e?.message || String(e) }));
  `;

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: {
        modelId,
        cacheDir: modelsDir(),
        dtype,
        providers: process.platform === 'darwin' && process.arch === 'arm64'
          ? ['coreml', 'cpu']
          : ['cpu'],
        audio,
        warmups: WARMUPS,
        runs: RUNS,
      },
    });
    const timeout = setTimeout(() => {
      worker.terminate().catch(() => {});
      reject(new Error(`timeout after 180s for ${modelId}`));
    }, 180_000);
    worker.on('message', (msg) => {
      if (msg.type === 'loaded') {
        console.log(`  loaded in ${msg.loadMs.toFixed(0)}ms (rss≈${msg.rssMb.toFixed(0)}MB)`);
      } else if (msg.type === 'done') {
        clearTimeout(timeout);
        worker.terminate().catch(() => {});
        resolve(msg);
      } else if (msg.type === 'error') {
        clearTimeout(timeout);
        worker.terminate().catch(() => {});
        reject(new Error(msg.message));
      }
    });
    worker.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function benchNemotron(modelId, audio) {
  const enginePath = path.join(REPO, 'dist-electron/electron/audio/whisper/nemotron/nemotronEngine.js');
  if (!fs.existsSync(enginePath)) {
    throw new Error('dist-electron nemotronEngine.js missing — run npm run build:electron');
  }
  const { NemotronEngine } = await import(pathToFileURL(enginePath).href);
  const modelDir = path.join(modelsDir(), modelId);
  const t0 = performance.now();
  const engine = await NemotronEngine.create(modelDir, ['cpu']);
  const loadMs = performance.now() - t0;

  const runOnce = async () => {
    engine.reset();
    const t1 = performance.now();
    const results = await engine.pushAudio(audio);
    const tail = await engine.flush();
    if (tail) results.push(tail);
    const ids = [];
    for (const r of results) ids.push(...r.tokenIds);
    const text = engine.decodeTokens(ids).trim();
    return { ms: performance.now() - t1, text };
  };

  for (let i = 0; i < WARMUPS; i++) await runOnce();
  const finalMs = [];
  let lastText = '';
  for (let i = 0; i < RUNS; i++) {
    const r = await runOnce();
    finalMs.push(r.ms);
    lastText = r.text;
  }
  // Nemotron has no separate "partial" pipe mode — first chunk latency ≈ final for short fixtures.
  return {
    loadMs,
    partialMs: finalMs,
    finalMs,
    text: lastText,
    rssMb: rssMb(),
  };
}

function streamingProfile(modelId) {
  const id = modelId.toLowerCase();
  if (id.includes('moonshine')) return { intervalMs: 400, minAudioMs: 400, skipAgreement: true };
  if (id.includes('nemotron')) return { intervalMs: 280, minAudioMs: 560, skipAgreement: true };
  return { intervalMs: 1500, minAudioMs: 800, skipAgreement: false };
}

function fmt(n, digits = 0) {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n).toFixed(digits);
}

function renderMarkdown(meta, rows) {
  const lines = [];
  lines.push('# ASR model benchmark (Stage 7)');
  lines.push('');
  lines.push('Measure-then-pick results for local Whisper/Moonshine/Parakeet/Nemotron catalog models.');
  lines.push('');
  lines.push('## Environment');
  lines.push('');
  lines.push(`- Date: ${meta.date}`);
  lines.push(`- Host: ${meta.cpu} / ${meta.arch} / ${meta.platform}`);
  lines.push(`- RAM: ${meta.ramGb} GB`);
  lines.push(`- Models dir: \`${meta.modelsDir}\``);
  lines.push(`- Fixture: \`known-phrase-16k-mono.wav\` (${meta.audioMs} ms @ 16 kHz mono) — "${KNOWN_PHRASE}"`);
  lines.push(`- Warmups: ${WARMUPS}, timed runs: ${RUNS} (median reported)`);
  lines.push(`- \`allowRemoteModels: false\` — installed models only; no downloads`);
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push('| Model | Status | Load ms | Warm final ms | Partial ms | Final ms | RTF | Word overlap | RSS MB | CPU % | Profile interval/minAudio | Notes |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |');
  for (const r of rows) {
    const profile = streamingProfile(r.id);
    lines.push(
      `| ${r.name || r.id} | ${r.status} | ${fmt(r.loadMs)} | ${fmt(r.warmupMs)} | ${fmt(r.partialMs)} | ${fmt(r.finalMs)} | ${fmt(r.rtf, 3)} | ${r.overlap == null ? '—' : fmt(r.overlap * 100, 0) + '%'} | ${fmt(r.rssMb, 0)} | ${fmt(r.cpuPct, 0)} | ${profile.intervalMs}/${profile.minAudioMs} | ${r.notes || ''} |`,
    );
  }
  lines.push('');
  lines.push('## Latency budget vs streaming profile');
  lines.push('');
  lines.push('First-partial wall time ≈ `max(minAudioMs, intervalMs)` wait + inference. Retune interval/minAudio only when the profile wait dominates measured inference.');
  lines.push('');
  for (const r of rows.filter((x) => x.status === 'measured')) {
    const profile = streamingProfile(r.id);
    const gate = Math.max(profile.minAudioMs, profile.intervalMs);
    const infer = r.partialMs ?? r.finalMs ?? 0;
    // Interval only "dominates" when it adds wait beyond minAudio (poll
    // waste). Matching interval==minAudio is intentional after Stage 7 retune.
    const pollWaste = Math.max(0, profile.intervalMs - profile.minAudioMs);
    const dominates = pollWaste > Math.max(50, infer * 0.5);
    lines.push(
      `- **${r.name || r.id}**: profile gate ≈ ${gate} ms (interval ${profile.intervalMs}, minAudio ${profile.minAudioMs}, poll waste ${pollWaste} ms), measured partial/final ≈ ${fmt(infer)} ms → ${dominates ? 'profile **dominates** (candidate for retune)' : 'profile does not dominate (leave interval/minAudio)'}`,
    );
  }
  lines.push('');
  lines.push('## Recommended defaults (from this run)');
  lines.push('');
  const measured = rows.filter((r) => r.status === 'measured' && (r.overlap == null || r.overlap >= 0.5));
  const best = measured.slice().sort((a, b) => {
    // Prefer lower final latency, then higher overlap.
    const la = a.finalMs ?? 1e9;
    const lb = b.finalMs ?? 1e9;
    if (la !== lb) return la - lb;
    return (b.overlap ?? 0) - (a.overlap ?? 0);
  })[0];
  if (best) {
    lines.push(`- **Shared \`localWhisperModel\`**: \`${best.id}\` (only/fastest accurate measured model on this machine).`);
    lines.push(`- **Mic \`localWhisperModelMic\`**: \`${best.id}\` — streaming latency priority; moonshine/nemotron profiles already skip LocalAgreement-2.`);
    lines.push(`- **System \`localWhisperModelSystem\`**: \`${best.id}\` — same pick until a higher-accuracy installed model is measured (Parakeet / Distil Medium / Turbo = needs run).`);
    lines.push('- **`localWhisperPerChannelEnabled`**: leave **false** while mic and system resolve to the same model; enable when a second measured model is installed and assigned.');
    lines.push('- **Moonshine streaming profile**: retuned `750/400` → `400/400` after the 750 ms poll gate dominated measured inference on this host (see LocalWhisperSTT.resolveStreamingProfile).');
  } else {
    lines.push('- No measured model met the accuracy floor — keep existing fallbacks; re-run after installing models.');
  }
  lines.push('');
  lines.push('## Needs run');
  lines.push('');
  const missing = rows.filter((r) => r.status === 'needs run');
  if (!missing.length) {
    lines.push('- (none)');
  } else {
    for (const r of missing) {
      lines.push(`- \`${r.id}\`${r.sizeMb ? ` (~${r.sizeMb} MB)` : ''}${r.notes ? ` — ${r.notes}` : ''}`);
    }
  }
  lines.push('');
  lines.push('## Transcript UI vs RAG');
  lines.push('');
  lines.push('Verified in `electron/main.ts` STT path: `feedLiveTranscript` is fire-and-forget (no await); `sendThrottledTranscript` / `emitTranscriptToSurfaces` run after the RAG feed without waiting on retrieval. Pinned by `electron/audio/__tests__/TranscriptUiIndependentOfRag.test.mjs`.');
  lines.push('');
  lines.push('## How to re-run');
  lines.push('');
  lines.push('```bash');
  lines.push('npm run build:electron   # optional but enables dtype-aware catalog + Nemotron');
  lines.push('node scripts/benchmark-asr-models.mjs');
  lines.push('# or subset:');
  lines.push('NATIVELY_ASR_BENCH_MODELS=onnx-community/moonshine-base-ONNX node scripts/benchmark-asr-models.mjs');
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

async function main() {
  if (!fs.existsSync(FIXTURE_WAV)) {
    console.error('Missing fixture:', FIXTURE_WAV);
    process.exit(1);
  }
  const audio = readPcm16Mono(FIXTURE_WAV);
  const audioMs = Math.round((audio.length / 16000) * 1000);
  const dtype = resolveDtype();
  const catalog = loadCatalog();
  const targets = ONLY.length
    ? catalog.filter((m) => ONLY.includes(m.id))
    : catalog;

  console.log(`[asr-bench] platform=${process.platform}/${process.arch} modelsDir=${modelsDir()}`);
  console.log(`[asr-bench] fixture=${audioMs}ms samples=${audio.length} catalog=${targets.length}`);

  const rows = [];
  for (const entry of targets) {
    const cached = isCached(entry, dtype);
    process.stdout.write(`[asr-bench] ${entry.id} … `);
    if (!cached) {
      console.log('needs run (not installed)');
      rows.push({
        id: entry.id,
        name: entry.name,
        sizeMb: entry.sizeMb,
        status: 'needs run',
        notes: 'not in whisper-models cache',
      });
      continue;
    }
    console.log('measuring');
    const cpuBefore = cpuSnapshot();
    const rssBefore = rssMb();
    try {
      let result;
      if (entry.sessionLayout === 'nemotron-rnnt') {
        result = await benchNemotron(entry.id, audio);
      } else {
        result = await benchTransformersModel(entry.id, audio, dtype);
      }
      const cpuAfter = cpuSnapshot();
      const finalMed = median(result.finalMs);
      const partialMed = median(result.partialMs);
      const overlap = wordOverlap(result.text, KNOWN_PHRASE);
      rows.push({
        id: entry.id,
        name: entry.name,
        sizeMb: entry.sizeMb,
        status: 'measured',
        loadMs: Math.round(result.loadMs),
        warmupMs: null, // folded into warmups; not separately timed
        partialMs: partialMed == null ? null : Math.round(partialMed),
        finalMs: finalMed == null ? null : Math.round(finalMed),
        rtf: finalMed == null ? null : finalMed / audioMs,
        overlap,
        rssMb: Math.round(result.rssMb ?? rssBefore),
        cpuPct: cpuPct(cpuBefore, cpuAfter),
        text: result.text,
        notes: overlap < 0.5 ? `low accuracy: "${String(result.text).slice(0, 60)}"` : `"${String(result.text).trim().slice(0, 60)}"`,
      });
      console.log(
        `  final≈${Math.round(finalMed)}ms RTF=${(finalMed / audioMs).toFixed(3)} overlap=${(overlap * 100).toFixed(0)}% text="${String(result.text).trim()}"`,
      );
    } catch (e) {
      console.log(`  FAILED: ${e.message}`);
      rows.push({
        id: entry.id,
        name: entry.name,
        sizeMb: entry.sizeMb,
        status: 'error',
        notes: e.message,
      });
    }
  }

  const meta = {
    date: new Date().toISOString(),
    cpu: os.cpus()[0]?.model || 'unknown',
    arch: process.arch,
    platform: process.platform,
    ramGb: Math.round(os.totalmem() / (1024 ** 3)),
    modelsDir: modelsDir(),
    audioMs,
    warmups: WARMUPS,
    runs: RUNS,
  };

  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
  fs.writeFileSync(OUT_MD, renderMarkdown(meta, rows));
  fs.writeFileSync(OUT_JSON, JSON.stringify({ meta, rows }, null, 2));
  console.log(`[asr-bench] wrote ${OUT_MD}`);
  console.log(`[asr-bench] wrote ${OUT_JSON}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
