// Change 46 — final RAG validation gate.
//
// Place at:
//   electron/rag/__tests__/Change46FinalValidation.test.mjs
//
// Run after build:
//   node --test electron/rag/__tests__/Change46FinalValidation.test.mjs
//
// This is intentionally a validation gate, not a replacement for the existing
// focused RAG/Context/LLM/audio suites. It checks the final architecture and
// pins the product-critical curated-technical behavior that Changes 29–31
// currently do not prove.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const rag = read('electron/rag/RAGManager.ts');
const plannerSrc = read('electron/rag/RagQueryPlanner.ts');
const canonicalSchema = read('electron/rag/canonical/CanonicalRagSchema.ts');
const canonicalIndexer = read('electron/rag/canonical/CanonicalRagIndexer.ts');
const embeddingResolver = read('electron/rag/EmbeddingProviderResolver.ts');
const localPrivate = read('electron/rag/localPrivateRagMode.ts');
const safeExtractor = read('electron/services/SafeDocumentTextExtractor.ts');
const ipc = read('electron/ipcHandlers.ts');
const interfaceSrc = read('src/components/NativelyInterface.tsx');
const answerContract = read('electron/rag/chatAnswerContract.ts');
const change45 = read('electron/rag/__tests__/Change45LegacyStorageKeepGate.test.mjs');
const meetingQuery = read('electron/rag/RAGManager.ts');

test('Change 46 — canonical storage contains revision, chunk, embedding-space, job, FTS and status foundations', () => {
  for (const table of [
    'rag_documents',
    'rag_document_revisions',
    'rag_chunks',
    'rag_embedding_spaces',
    'rag_embeddings',
    'rag_canonical_index_status',
    'rag_index_jobs',
    'rag_chunks_fts',
  ]) {
    assert.match(canonicalSchema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}|CREATE VIRTUAL TABLE IF NOT EXISTS ${table}`), table);
  }
  assert.match(canonicalSchema, /physical_row_key INTEGER NOT NULL UNIQUE/);
  assert.match(canonicalSchema, /UNIQUE\(chunk_id, embedding_space_id\)/);
  assert.match(canonicalSchema, /current_revision_id/);
});

test('Change 46 — canonical indexer proves FTS → embedding → vector → READY → activation', () => {
  assert.match(canonicalIndexer, /rebuild_fts/);
  assert.match(canonicalIndexer, /setStatus\(document\.id, revision\.id, 'LEXICAL_READY'/);
  assert.match(canonicalIndexer, /jobType: 'embed'/);
  assert.match(canonicalIndexer, /setStatus\(document\.id, revision\.id, 'EMBEDDING'/);
  assert.match(canonicalIndexer, /setStatus\(document\.id, revision\.id, 'READY'/);
  assert.match(canonicalIndexer, /rebuild_vector_index/);
  assert.match(canonicalIndexer, /activateRevision/);
});

test('Change 46 — supported document ingestion formats include PDF, DOCX, TXT and CSV', () => {
  for (const ext of ['.pdf', '.docx', '.txt', '.csv']) {
    assert.match(safeExtractor, new RegExp(`['"]${ext.replace('.', '\\.')}['"]`), ext);
  }
});

test('Change 46 — embedding space/provider abstraction remains source-independent', () => {
  assert.match(embeddingResolver, /OpenAIEmbeddingProvider/);
  assert.match(embeddingResolver, /GeminiEmbeddingProvider/);
  assert.match(embeddingResolver, /OllamaEmbeddingProvider/);
  assert.match(embeddingResolver, /LocalEmbeddingProvider/);
  assert.match(embeddingResolver, /provider\.dimensions/);
  assert.match(localPrivate, /local-retrieval/);
  assert.match(localPrivate, /full-local/);
});

test('Change 46 — local/private retrieval pins bundled MiniLM instead of Ollama', () => {
  assert.match(embeddingResolver, /bundledLocalEmbeddings/);
  assert.match(embeddingResolver, /new LocalEmbeddingProvider\(\)/);
  assert.match(embeddingResolver, /local-private RAG: bundled MiniLM/);
});

test('Change 46 — universal search has planner → source retrieval → dedupe → rerank → gate → evidence pack', () => {
  const start = rag.indexOf('async search(query: string');
  const end = rag.indexOf('async retrieve(query: string', start);
  assert.ok(start >= 0 && end > start);
  const search = rag.slice(start, end);

  assert.match(search, /this\.queryPlanner\.plan/);
  assert.match(search, /resolveRagSearchSources/);
  assert.match(search, /meetingAdapter\.retrieve|canonicalRead\.readSource/);
  assert.match(search, /modeAdapter\.retrieve|canonicalRead\.readSource/);
  assert.match(search, /personalAdapter\.retrieve|canonicalRead\.readSource/);
  assert.match(search, /knowledgeAdapter\.retrieve/);
  assert.match(search, /dedupeRagSearchResults/);
  assert.match(search, /rerankCanonicalResults/);
  assert.match(search, /gateCanonicalResults/);
  assert.match(search, /toRagSearchResponse/);
});

test('Change 46 — normal manual chat reaches RAGManager through the unified retrieval port', () => {
  assert.match(interfaceSrc, /electronAPI\.streamGeminiChat/);
  assert.match(ipc, /createRAGRetrievalPort/);
  assert.match(rag, /public createRAGRetrievalPort/);
  assert.match(rag.slice(rag.indexOf('public createRAGRetrievalPort'), rag.indexOf('async search(query: string')), /this\.search\(/);
});

test('Change 46 — answer + citations share one IPC contract', () => {
  assert.match(answerContract, /text: string/);
  assert.match(answerContract, /citations:/);
  assert.match(answerContract, /ragUsed:/);
  assert.match(ipc, /chatAnswerIpcFields\(toChatAnswerContract/);
});

test('Change 46 — meeting/global overlays use the unified search engine', () => {
  const meetingStart = meetingQuery.indexOf('async *queryMeeting');
  const globalStart = meetingQuery.indexOf('async *queryGlobal');
  const streamStart = meetingQuery.indexOf('private async *streamRagAnswer');
  assert.ok(meetingStart >= 0 && globalStart > meetingStart && streamStart > globalStart);
  assert.match(meetingQuery.slice(meetingStart, globalStart), /this\.search\(/);
  assert.match(meetingQuery.slice(globalStart, streamStart), /this\.search\(/);
  assert.doesNotMatch(meetingQuery.slice(meetingStart, streamStart), /this\.retriever\.retrieve(?:Global)?\(/);
});

test('Change 46 — Change 45 legacy keep-gate remains in force', () => {
  assert.match(change45, /canonicalRagRead stays default off/);
  assert.match(change45, /shouldWriteLegacyRagChunks stays the inverse/);
  assert.match(change45, /Change 45 does not DROP legacy RAG tables/);
});

test('Change 46 — RAG planner still skips clearly generative chat', async () => {
  const dist = path.join(root, 'dist-electron/electron/rag/RagQueryPlanner.js');
  assert.ok(fs.existsSync(dist), `Build first: missing ${dist}`);
  const { RagQueryPlanner } = await import(pathToFileURL(dist).href);
  const plan = new RagQueryPlanner().plan('write me a funny birthday message');
  assert.equal(plan.retrievalMode, 'skip');
  assert.equal(plan.needsDocumentEvidence, false);
  assert.deepEqual(plan.sources, []);
});

test('Change 46 — PRODUCT REQUIREMENT: Context Intelligence must not FAST-short-circuit curated technical questions when documents exist', async () => {
  const classifierDist = path.join(
    root,
    'dist-electron/electron/context-intelligence/question/turn-classifier.js',
  );
  const policyDist = path.join(
    root,
    'dist-electron/electron/context-intelligence/policies/mode-policy-registry.js',
  );
  assert.ok(fs.existsSync(classifierDist), `Build first: missing ${classifierDist}`);
  assert.ok(fs.existsSync(policyDist), `Build first: missing ${policyDist}`);

  const { classifyTurn } = await import(pathToFileURL(classifierDist).href);
  const { resolveModePolicy } = await import(pathToFileURL(policyDist).href);
  const policy = resolveModePolicy('general');

  const withCuratedFiles = classifyTurn({
    resolvedQuestion: 'What is polymorphism?',
    policy,
    isFollowUp: false,
    hasAttachedDocuments: true,
    attachedFileNames: ['OOPS Interview Answers.pdf'],
  });

  assert.equal(
    withCuratedFiles.shouldRetrieve,
    true,
    `curated technical question was short-circuited: ${withCuratedFiles.reason}`,
  );
  assert.notEqual(
    withCuratedFiles.path,
    'FAST',
    `curated technical question must reach retrieval: ${withCuratedFiles.reason}`,
  );

  const withoutCuratedFiles = classifyTurn({
    resolvedQuestion: 'What is polymorphism?',
    policy,
    isFollowUp: false,
    hasAttachedDocuments: false,
    attachedFileNames: [],
  });

  assert.equal(withoutCuratedFiles.path, 'FAST');
  assert.equal(withoutCuratedFiles.shouldRetrieve, false);
});

test('Change 46 — RAG planner retrieves explicit document questions', async () => {
  const dist = path.join(root, 'dist-electron/electron/rag/RagQueryPlanner.js');
  assert.ok(fs.existsSync(dist), `Build first: missing ${dist}`);
  const { RagQueryPlanner } = await import(pathToFileURL(dist).href);
  const plan = new RagQueryPlanner().plan('what does the annual report say about revenue?');
  assert.equal(plan.retrievalMode, 'retrieve');
  assert.equal(plan.needsDocumentEvidence, true);
  assert.ok(plan.sources.includes('mode-reference'));
});

test('Change 46 — PRODUCT REQUIREMENT: curated technical questions become retrieval candidates when curated files exist', async () => {
  const dist = path.join(root, 'dist-electron/electron/rag/RagQueryPlanner.js');
  assert.ok(fs.existsSync(dist), `Build first: missing ${dist}`);
  const { RagQueryPlanner } = await import(pathToFileURL(dist).href);
  const plan = new RagQueryPlanner().plan(
    'What is polymorphism?',
    undefined,
    {
      hasPersonalFiles: true,
      hasModeReferenceFiles: false,
      hasMeeting: false,
      conversationAware: false,
    },
  );

  // This is the deliberate Change 46 gate for the known 29/31 gap.
  // A curated corpus may contain the exact technical/interview framing even
  // when the question itself does not say "PDF", "document", or "my files".
  assert.equal(plan.retrievalMode, 'retrieve');
  assert.equal(plan.needsDocumentEvidence, true);
  assert.ok(
    plan.sources.includes('personal-files') || plan.sources.includes('mode-reference'),
    `expected a curated document source, got ${JSON.stringify(plan.sources)}`,
  );
});

test('Change 46 — unrelated factual chat remains eligible for the fast path when no curated corpus exists', async () => {
  const dist = path.join(root, 'dist-electron/electron/rag/RagQueryPlanner.js');
  assert.ok(fs.existsSync(dist), `Build first: missing ${dist}`);
  const { RagQueryPlanner } = await import(pathToFileURL(dist).href);
  const plan = new RagQueryPlanner().plan(
    'What is the capital of France?',
    undefined,
    {
      hasPersonalFiles: false,
      hasModeReferenceFiles: false,
      hasMeeting: false,
      conversationAware: false,
    },
  );
  assert.equal(plan.retrievalMode, 'skip');
  assert.equal(plan.needsDocumentEvidence, false);
});

test('Change 46 — no RAG source family is silently replaced by profile or Hindsight memory', () => {
  assert.doesNotMatch(plannerSrc, /sources\.push\(['"]profile['"]\)/);
  assert.doesNotMatch(plannerSrc, /sources\.push\(['"]hindsight['"]\)/);
  assert.match(rag, /profile.*not.*document RAG|profile \/ long-term memory are not document RAG/i);
});
