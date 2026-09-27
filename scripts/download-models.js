const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const { spawnSync } = require('child_process');

// Required core-fallback model files. The BGE reranker is also required for
// smart-retrieval Phase 1/3 (confidence-gated local rerank escalation) and is
// bundled so a clean-machine install never has to download a 280MB cross-encoder
// on first document-grounded mode activation.
const REQUIRED_MODEL_FILES = [
    'Xenova/all-MiniLM-L6-v2/config.json',
    'Xenova/all-MiniLM-L6-v2/tokenizer.json',
    'Xenova/all-MiniLM-L6-v2/tokenizer_config.json',
    'Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx',
    'Xenova/mobilebert-uncased-mnli/config.json',
    'Xenova/mobilebert-uncased-mnli/tokenizer.json',
    'Xenova/mobilebert-uncased-mnli/tokenizer_config.json',
    'Xenova/mobilebert-uncased-mnli/onnx/model_quantized.onnx',
    'Xenova/bge-reranker-base/config.json',
    'Xenova/bge-reranker-base/tokenizer.json',
    'Xenova/bge-reranker-base/tokenizer_config.json',
    'Xenova/bge-reranker-base/onnx/model_quantized.onnx',
];

// OPTIONAL assets (review#9): verified with a WARNING, never a failure — the
// runtime degrades without them. The packaged-release gate
// (verify-packaged-local-assets.mjs) is the one place they stay REQUIRED.
const OPTIONAL_MODEL_FILES = [
    'pipecat-ai/smart-turn-v3/smart-turn-v3.1-cpu.onnx',
];

const MODELS_DIR = path.join(__dirname, '../resources/models');

/** True when GitHub Actions / common CI runners set CI. */
function isCiEnv(env = process.env) {
    return env.CI === 'true' || env.CI === '1';
}

/** Explicit escape hatch — mirrors NATIVELY_SKIP_NOTARIZE / NATIVELY_SKIP_ARCH_GATE. */
function isSkipModelDownload(env = process.env) {
    return env.NATIVELY_SKIP_MODEL_DOWNLOAD === '1';
}

function modelFileOk(modelsDir, rel) {
    const full = path.join(modelsDir, rel);
    try {
        return fs.existsSync(full) && fs.statSync(full).size > 0;
    } catch {
        return false;
    }
}

function requiredModelsPresent(modelsDir = MODELS_DIR) {
    return REQUIRED_MODEL_FILES.every((rel) => modelFileOk(modelsDir, rel));
}

/**
 * Decide whether postinstall should skip the transformers.js download entirely.
 * Pure — unit-tested. Skip avoids loading onnxruntime-node (SIGABRT on teardown).
 */
function shouldSkipModelDownload(env = process.env, modelsDir = MODELS_DIR) {
    if (isSkipModelDownload(env)) {
        return { skip: true, reason: 'NATIVELY_SKIP_MODEL_DOWNLOAD=1' };
    }
    if (requiredModelsPresent(modelsDir)) {
        return { skip: true, reason: 'required model files already present' };
    }
    return { skip: false, reason: null };
}

/**
 * After the ORT worker exits (often SIGABRT / exit 134 from "mutex lock failed"),
 * decide the parent install exit code. Models on disk win; CI soft-fails so npm ci
 * is not poisoned by teardown aborts.
 */
function resolvePostWorkerOutcome({
    status,
    signal,
    modelsPresent,
    env = process.env,
} = {}) {
    if (modelsPresent) {
        const aborted = signal === 'SIGABRT' || status === 134;
        return {
            exitCode: 0,
            message: aborted
                ? 'worker aborted after download (onnxruntime teardown); required models present — treating as success'
                : 'required models present',
        };
    }
    if (isSkipModelDownload(env) || isCiEnv(env)) {
        return {
            exitCode: 0,
            message: `download incomplete (status=${status}, signal=${signal}); soft-failing in CI / skip mode so npm install can finish`,
        };
    }
    return {
        exitCode: status === 0 || status == null ? 1 : status,
        message: `download failed (status=${status}, signal=${signal}) and required models are missing`,
    };
}

/** Plain HTTPS download with redirects, to a temp path, then sha256-verified rename. */
function downloadVerified(url, dest, expectedSha256, expectedBytes) {
    return new Promise((resolve, reject) => {
        const tmp = dest + '.part';
        const get = (u, redirects) => {
            https.get(u, { headers: { 'User-Agent': 'natively-download-models' } }, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
                    res.resume();
                    return get(new URL(res.headers.location, u).toString(), redirects + 1);
                }
                if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${u}`)); }
                const hash = crypto.createHash('sha256');
                const out = fs.createWriteStream(tmp);
                let bytes = 0;
                res.on('data', (c) => { hash.update(c); bytes += c.length; });
                res.pipe(out);
                out.on('finish', () => {
                    const digest = hash.digest('hex');
                    if (digest !== expectedSha256) { fs.rmSync(tmp, { force: true }); return reject(new Error(`sha256 mismatch for ${dest}: ${digest} != ${expectedSha256}`)); }
                    if (expectedBytes && bytes !== expectedBytes) { fs.rmSync(tmp, { force: true }); return reject(new Error(`size mismatch for ${dest}: ${bytes} != ${expectedBytes}`)); }
                    fs.renameSync(tmp, dest);
                    resolve();
                });
                out.on('error', reject);
            }).on('error', reject);
        };
        get(url, 0);
    });
}

function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Smart Turn v3.1: manifest-driven, idempotent (skips when the on-disk hash already matches). */
async function downloadSmartTurn(modelsDir) {
    const dir = path.join(modelsDir, 'pipecat-ai', 'smart-turn-v3');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const dest = path.join(dir, manifest.file);
    if (fs.existsSync(dest) && sha256File(dest) === manifest.sha256) {
        console.log('[download-models] smart-turn-v3.1 already present (sha256 OK).');
        return;
    }
    console.log(`[download-models] Downloading ${manifest.model}/${manifest.file} (${(manifest.bytes / 1e6).toFixed(1)} MB, ${manifest.license})...`);
    await downloadVerified(manifest.url, dest, manifest.sha256, manifest.bytes);
    console.log('[download-models] smart-turn-v3.1 downloaded and sha256-verified.');
}

function verifyModels({ exitOnFail = true } = {}) {
    const missing = [];
    for (const rel of REQUIRED_MODEL_FILES) {
        if (!modelFileOk(MODELS_DIR, rel)) missing.push(path.join(MODELS_DIR, rel));
    }
    if (missing.length > 0) {
        console.error('[download-models] VERIFY FAILED — required model files missing or empty:');
        for (const m of missing) console.error('  ✗', m);
        if (exitOnFail) process.exit(1);
        return false;
    }
    for (const rel of OPTIONAL_MODEL_FILES) {
        if (!modelFileOk(MODELS_DIR, rel)) {
            console.warn(`[download-models] optional asset missing (feature degrades gracefully): ${rel}`);
        }
    }
    console.log('[download-models] VERIFY OK — all required core-fallback model files present.');
    return true;
}

async function downloadModels() {
    const { pipeline, env } = await import('@huggingface/transformers');
    const modelsDir = MODELS_DIR;

    if (!fs.existsSync(modelsDir)) {
        fs.mkdirSync(modelsDir, { recursive: true });
    }

    // Let Transformers.js handle the download but specify the local directory cache
    env.cacheDir = modelsDir;

    // dtype MUST be explicit on transformers.js v3 (we ship 3.8.1). v2 defaulted to
    // the quantized variant and honored `quantized: true`; v3 ignores that flag and
    // defaults to fp32, so a bare `pipeline(...)` call writes onnx/model.onnx while
    // REQUIRED_MODEL_FILES below — and electron/services/LocalFallbackAssets.ts, and
    // scripts/verify-packaged-local-assets.mjs — all require onnx/model_quantized.onnx.
    // Left implicit, every clean install silently produces the wrong filename and the
    // build dies at verify:packaged-local-assets. 'q8' is what maps to
    // model_quantized.onnx; see the same reasoning at electron/rag/LocalReranker.ts.
    const QUANTIZED = { dtype: 'q8' };

    // 1. Embedding model (RAG)
    console.log('[download-models] Downloading Xenova/all-MiniLM-L6-v2 (q8)...');
    await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', QUANTIZED);
    console.log('[download-models] all-MiniLM-L6-v2 downloaded.');

    // 2. Zero-shot classification model (Intent Classifier)
    console.log('[download-models] Downloading Xenova/mobilebert-uncased-mnli (q8)...');
    await pipeline('zero-shot-classification', 'Xenova/mobilebert-uncased-mnli', QUANTIZED);
    console.log('[download-models] mobilebert-uncased-mnli downloaded.');

    // 3. Cross-encoder reranker (smart-retrieval Phase 1/3 — confidence-gated
    //    rerank escalation). Bundled in resources/models/ so a clean-machine
    //    install can do offline rerank without a 280MB first-activation
    //    download. The installer ships the q8 quantized variant (~280MB).
    //
    //    The lazy-download provider in electron/rag/rerankerDownloadProvider.ts
    //    still acts as a no-op fallback if the bundled model is absent
    //    (e.g. an old installer predating this bundling).
    console.log('[download-models] Downloading Xenova/bge-reranker-base (q8)...');
    // Use dtype:'q8' so transformers.js selects the quantized ONNX variant
    // (~280 MB) instead of the fp32 one (~1.1 GB). NATIVELY_RERANKER_DTYPE
    // override remains for accuracy experiments.
    const rerankerDtype = (process.env.NATIVELY_RERANKER_DTYPE || 'q8').trim() || 'q8';
    await pipeline('text-classification', 'Xenova/bge-reranker-base', { dtype: rerankerDtype });
    console.log('[download-models] bge-reranker-base downloaded.');

    // 4. Smart Turn v3.1 (Auto Answer V3 TurnPredictor). Raw ONNX, not a
    //    transformers.js pipeline: fetched by URL and sha256-verified against
    //    resources/models/pipecat-ai/smart-turn-v3/manifest.json.
    //    OPTIONAL (review#9): the runtime degrades to the deterministic
    //    endpoint path without it, so a blocked download must not fail the
    //    install. Release builds are still gated by
    //    verify-packaged-local-assets.mjs, which requires the file.
    try {
        await downloadSmartTurn(modelsDir);
    } catch (e) {
        console.warn('[download-models] smart-turn-v3.1 download failed (optional; Auto Answer runs deterministic-only):', e?.message ?? e);
    }

    console.log('[download-models] All models downloaded successfully!');
}

/**
 * Run the ORT-touching download in a child process. onnxruntime-node often
 * SIGABRTs ("mutex lock failed") on teardown even after a successful download;
 * that Abort trap 6 becomes npm error 134 and kills postinstall. The parent
 * never loads ORT — it only inspects the filesystem / exit signal.
 */
function runDownloadWorker() {
    const result = spawnSync(process.execPath, [__filename, '--worker'], {
        env: { ...process.env, NATIVELY_MODEL_DOWNLOAD_WORKER: '1' },
        stdio: 'inherit',
    });
    const outcome = resolvePostWorkerOutcome({
        status: result.status,
        signal: result.signal,
        modelsPresent: requiredModelsPresent(),
        env: process.env,
    });
    console.log(`[download-models] ${outcome.message}`);
    process.exit(outcome.exitCode);
}

async function runWorkerDownload() {
    try {
        await downloadModels();
        // Do NOT process.exit() here — a live onnxruntime session + process.exit
        // SIGABRTs ("mutex lock failed"). Natural unwind still may abort; the
        // parent treats SIGABRT as success when files are on disk.
        process.exitCode = requiredModelsPresent() ? 0 : 1;
    } catch (e) {
        console.error('[download-models] Error downloading model:', e);
        // Soft exitCode only — never process.exit after ORT may have loaded.
        process.exitCode = 1;
    }
}

function main() {
    if (process.argv.includes('--verify')) {
        verifyModels();
        return;
    }

    if (process.argv.includes('--worker') || process.env.NATIVELY_MODEL_DOWNLOAD_WORKER === '1') {
        runWorkerDownload().catch((e) => {
            console.error('[download-models] Fatal error:', e);
            process.exitCode = 1;
        });
        return;
    }

    const decision = shouldSkipModelDownload();
    if (decision.skip) {
        console.log(`[download-models] Skipping download (${decision.reason}).`);
        // Still surface optional-asset warnings when verifying a cached tree.
        if (requiredModelsPresent()) verifyModels({ exitOnFail: false });
        return;
    }

    runDownloadWorker();
}

module.exports = {
    REQUIRED_MODEL_FILES,
    OPTIONAL_MODEL_FILES,
    MODELS_DIR,
    isCiEnv,
    isSkipModelDownload,
    requiredModelsPresent,
    shouldSkipModelDownload,
    resolvePostWorkerOutcome,
    verifyModels,
};

if (require.main === module) {
    main();
}
