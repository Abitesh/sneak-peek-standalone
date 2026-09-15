import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const distPath = path.join(root, 'dist-electron/electron/rag/localPrivateRagMode.js');

async function loadMode() {
  return import(pathToFileURL(distPath).href);
}

function handlerBlock(source, handlerName) {
  const start = source.indexOf(`safeHandle('${handlerName}'`);
  assert.ok(start >= 0, `${handlerName} handler must exist`);
  const next = source.indexOf('safeHandle(', start + 1);
  return source.slice(start, next > start ? next : start + 2800);
}

test('Mode A overlays embeddings false without mutating stored scopes; Mode B is the only local-answer mode', async () => {
  const {
    applyLocalPrivateRagScopes,
    wantsLocalRetrieval,
    wantsLocalAnswers,
    parseLocalPrivateRagMode,
    isLocalPrivateRagMode,
  } = await loadMode();

  const stored = { embeddings: true, code_execution: false, transcript: true };
  const modeA = applyLocalPrivateRagScopes(stored, 'local-retrieval');
  assert.equal(modeA.embeddings, false);
  assert.equal(modeA.code_execution, false);
  assert.equal(modeA.transcript, true);
  assert.equal(stored.embeddings, true, 'stored scopes must stay untouched');

  const modeB = applyLocalPrivateRagScopes(stored, 'full-local');
  assert.equal(modeB.embeddings, false);

  const off = applyLocalPrivateRagScopes(stored, 'off');
  assert.equal(off, stored);
  assert.equal(applyLocalPrivateRagScopes(undefined, 'off'), undefined);
  assert.deepEqual(applyLocalPrivateRagScopes(undefined, 'local-retrieval'), { embeddings: false });

  assert.equal(wantsLocalRetrieval('off'), false);
  assert.equal(wantsLocalRetrieval('local-retrieval'), true);
  assert.equal(wantsLocalRetrieval('full-local'), true);
  assert.equal(wantsLocalAnswers('off'), false);
  assert.equal(wantsLocalAnswers('local-retrieval'), false, 'Mode A keeps cloud LLM');
  assert.equal(wantsLocalAnswers('full-local'), true, 'Mode B is local answers');

  assert.equal(parseLocalPrivateRagMode('full-local'), 'full-local');
  assert.equal(parseLocalPrivateRagMode('nope'), 'off');
  assert.equal(isLocalPrivateRagMode('local-retrieval'), true);
  assert.equal(isLocalPrivateRagMode('nope'), false);
});

test('applyLocalPrivateRagAnswers follows retrieval ≠ answer: only full-local enables LLM local-only', async () => {
  const { applyLocalPrivateRagAnswers } = await loadMode();
  const calls = [];
  applyLocalPrivateRagAnswers({ setLocalOnlyMode: (v) => calls.push(v) }, 'local-retrieval');
  applyLocalPrivateRagAnswers({ setLocalOnlyMode: (v) => calls.push(v) }, 'full-local');
  applyLocalPrivateRagAnswers({ setLocalOnlyMode: (v) => calls.push(v) }, 'off');
  assert.deepEqual(calls, [false, true, false]);
});

test('RAGManager overlays scopes at init and applies answer routing when the LLM helper is attached', () => {
  const src = read('electron/rag/RAGManager.ts');
  assert.match(src, /applyLocalPrivateRagScopes\(/);
  assert.match(src, /applyLocalPrivateRagAnswers\(/);
  const setHelper = src.slice(src.indexOf('setLLMHelper('), src.indexOf('setLLMHelper(') + 400);
  assert.match(setHelper, /applyLocalPrivateRagAnswers\(llmHelper\)/);
  assert.match(src, /providerDataScopes: applyLocalPrivateRagScopes\(/);
});

test('IPC persists localPrivateRagMode without mutating stored providerDataScopes', () => {
  const ipc = read('electron/ipcHandlers.ts');
  const getBlock = handlerBlock(ipc, 'get-local-private-rag-mode');
  const setBlock = handlerBlock(ipc, 'set-local-private-rag-mode');
  assert.match(getBlock, /parseLocalPrivateRagMode/);
  assert.match(setBlock, /isLocalPrivateRagMode/);
  assert.match(setBlock, /settings\.set\('localPrivateRagMode'/);
  assert.doesNotMatch(setBlock, /settings\.set\('providerDataScopes'/);
  assert.match(setBlock, /applyLocalPrivateRagAnswers/);
  assert.match(setBlock, /initializeEmbeddings/);
  assert.ok(
    setBlock.indexOf("settings.set('localPrivateRagMode'") < setBlock.indexOf('initializeEmbeddings'),
    'mode must persist before embedding reinit so MiniLM pin is read',
  );
  assert.match(setBlock, /local-private-rag-mode-changed/);
});

test('preload, types, SettingsManager, and Privacy UI expose the first-class mode', () => {
  const preload = read('electron/preload.ts');
  const types = read('src/types/electron.d.ts');
  const settings = read('electron/services/SettingsManager.ts');
  const ui = read('src/components/settings/AIProvidersSettings.tsx');

  assert.match(settings, /localPrivateRagMode\?: 'off' \| 'local-retrieval' \| 'full-local'/);
  assert.match(preload, /getLocalPrivateRagMode:/);
  assert.match(preload, /setLocalPrivateRagMode:/);
  assert.match(preload, /onLocalPrivateRagModeChanged:/);
  assert.match(preload, /ipcRenderer\.invoke\('get-local-private-rag-mode'\)/);
  assert.match(preload, /ipcRenderer\.invoke\('set-local-private-rag-mode'/);
  assert.match(types, /getLocalPrivateRagMode:\s*\(\)\s*=>\s*Promise<'off' \| 'local-retrieval' \| 'full-local'>/);
  assert.match(ui, /Local \/ private RAG/);
  assert.match(ui, /getLocalPrivateRagMode/);
  assert.match(ui, /setLocalPrivateRagMode/);
  assert.match(ui, /value="local-retrieval"/);
  assert.match(ui, /value="full-local"/);
  assert.match(ui, /res && res\.success === false/);
  assert.match(ui, /setLocalPrivateRagMode\(previous\)/);
});

test('Change 27 does not stop Mode status writers or invent a second RAG pipeline', () => {
  const mode = read('electron/services/modes/ModeHybridRetriever.ts');
  assert.match(mode, /private updateIndexState\(/);
  assert.match(mode, /private removeIndexState\(/);
  assert.match(mode, /private ensureIndexTable\(/);
  const helper = read('electron/rag/localPrivateRagMode.ts');
  assert.doesNotMatch(helper, /class LocalPrivateRagPipeline/);
});

test('local-retrieval and full-local force bundled MiniLM even when Ollama would be available', () => {
  const resolver = read('electron/rag/EmbeddingProviderResolver.ts');
  const resolveStart = resolver.indexOf('static async resolve(config: AppAPIConfig)');
  const ollamaPush = resolver.indexOf('new OllamaEmbeddingProvider', resolveStart);
  const bundledGate = resolver.indexOf('config.bundledLocalEmbeddings', resolveStart);
  assert.ok(bundledGate >= 0 && bundledGate < ollamaPush, 'bundled MiniLM must win before Ollama is constructed');
  assert.match(resolver.slice(bundledGate, ollamaPush), /new LocalEmbeddingProvider\(\)/);
  assert.match(resolver.slice(bundledGate, ollamaPush), /return local;/);
  const rag = read('electron/rag/RAGManager.ts');
  assert.match(rag, /bundledLocalEmbeddings:\s*wantsLocalRetrieval\(/);
  const pipeline = read('electron/rag/EmbeddingPipeline.ts');
  assert.match(pipeline, /this\.bundledLocalEmbeddings = Boolean\(config\.bundledLocalEmbeddings\)/);
  assert.match(pipeline, /this\.bundledLocalEmbeddings && fallback\.name !== 'local'/);
  const queryEmbed = pipeline.slice(pipeline.indexOf('async getEmbeddingForQuery('), pipeline.indexOf('get localDimensions()'));
  assert.match(queryEmbed, /canUseEmbeddingFallback\(/);
});

test('RAG answers use provider-neutral dispatch, not a hard-wired Gemini stream', () => {
  const src = read('electron/rag/RAGManager.ts');
  assert.doesNotMatch(src, /streamChatWithGemini\(/);
  assert.match(src, /streamChatWithOutcome\(/);
  const meeting = src.slice(src.indexOf('async *queryMeeting('), src.indexOf('async *queryGlobal('));
  const ragAnswerStart = src.indexOf('private async *streamRagAnswer(');
  assert.ok(ragAnswerStart > 0, 'streamRagAnswer must exist');
  const ragAnswer = src.slice(ragAnswerStart, src.indexOf('async *query('));
  assert.match(meeting, /streamRagAnswer\(/);
  assert.match(src.slice(src.indexOf('async *queryGlobal('), ragAnswerStart), /streamRagAnswer\(/);
  assert.match(ragAnswer, /streamChatWithOutcome\(/);
  assert.match(ragAnswer, /abortSignal/);
});
