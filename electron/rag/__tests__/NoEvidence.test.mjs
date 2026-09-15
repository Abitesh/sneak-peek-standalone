import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd(), 'electron/rag');
const retrieverPath = path.join(root, 'RAGRetriever.ts');
const managerPath = path.join(root, 'RAGManager.ts');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

test('Change 16: retriever exposes the first-class no-evidence contract', () => {
  const source = read(retrieverPath);
  assert.match(source, /export type RagRetrievalStatus = 'ok' \\| 'no_relevant_evidence'/);
  assert.match(source, /status:\s*RagRetrievalStatus;/);
  assert.match(source, /results:\s*T\[\];/);
  assert.match(source, /confidence:\s*number;/);
  assert.match(source, /status:\s*'no_relevant_evidence',\s*\nresults:\s*\[\],\s*\nconfidence:\s*0/);
});

test('Change 16: final retrieval output is passed through the canonical gate and question-specific relevance decision', () => {
  const source = read(retrieverPath);
  assert.match(source, /evaluateRagRelevanceGate\(/);
  assert.match(source, /hasQuestionSpecificRelevance\(/);
  assert.match(source, /if \(!hasQuestionSpecificRelevance\(query, chunks, intent\)\) return \[\];/);
  assert.match(source, /const gatedSelected = gateRetrievedChunks\(selected, query, intent\)/);
  assert.match(source, /return \[\];/);
  assert.match(source, /withRetrievedResults\(\s*gatedSelected/);
});

test('Change 16: vague candidates use existing strict-majority question coverage instead of a new score threshold', () => {
  const source = read(retrieverPath);
  assert.match(source, /strict-majority coverage/);
  assert.match(source, /covered \* 2 > terms\.length/);
  assert.match(source, /terms\.length === 1\s*\?\s*covered === 1/);
  assert.match(source, /intent === 'summary'/);
  assert.doesNotMatch(source, /0\.\d+.*relevance.*threshold/i);
});

test('Change 16: deferred retrieval cannot bypass the final no-evidence decision', () => {
  const source = read(retrieverPath);
  const start = source.indexOf('if (deferFinalSelection) {');
  const end = source.indexOf('const now = Date.now();', start);
  assert.ok(start >= 0 && end > start, 'deferred selection block must exist');
  const deferred = source.slice(start, end);
  assert.match(deferred, /const gatedCandidates = gateRetrievedChunks\(candidateChunks, query, intent\)/);
  assert.match(deferred, /withRetrievedResults\(\s*gatedCandidates/);
});

test('Change 16: unified manager gates canonical results before returning them', () => {
  const source = read(managerPath);
  assert.match(source, /private gateCanonicalResults\(\s*results: RagSearchResult\[\],\s*query: string,/);
  assert.match(source, /evaluateRagRelevanceGate\(/);
  assert.match(source, /hasQuestionSpecificRelevance\(/);
  assert.match(source, /const finalResults = this\.gateCanonicalResults\(results\.slice\(0, topK\), normalizedQuery/);
  assert.match(source, /return \{ status: 'no_relevant_evidence', results: \[\], confidence: 0 \};/);
});

test('Change 16: no-evidence state reaches the legacy meeting/global prompt path', () => {
  const source = read(managerPath);
  const occurrences = (source.match(/appendRagRetrievalStatus\('', context\.status\)/g) ?? []).length;
  assert.equal(occurrences, 2, 'meeting and global query paths must both propagate no-evidence status');
  assert.match(source, /<rag_retrieval_status>[\s\S]*NO GROUNDED EVIDENCE/);
});
