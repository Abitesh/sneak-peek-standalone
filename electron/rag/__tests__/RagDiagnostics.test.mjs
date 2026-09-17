import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach } from 'node:test';

const root = path.resolve(process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const diagPath = path.join(root, 'dist-electron/electron/rag/RagDiagnostics.js');

afterEach(() => {
  delete process.env.NATIVELY_RAG_DIAGNOSTICS;
});

const SECRET = 'SECRET_PAYROLL_SSN_999-99-9999';

function hit() {
  return {
    chunk: {
      id: 'c1',
      documentId: 'd1',
      text: SECRET,
      chunkIndex: 0,
      pageStart: 4,
      section: 'Payroll',
      metadata: {},
    },
    score: 0.91,
    source: { id: 'd1', sourceType: 'personal', name: 'comp.pdf', metadata: {} },
  };
}

test('diagnostics stay off unless NATIVELY_RAG_DIAGNOSTICS is set', async () => {
  delete process.env.NATIVELY_RAG_DIAGNOSTICS;
  const { isRagDiagnosticsEnabled, recordRagSearch } = await import(pathToFileURL(diagPath).href);
  assert.equal(isRagDiagnosticsEnabled(), false);
  const lines = [];
  recordRagSearch({
    originalQuery: 'what is my salary',
    retrievalQuery: 'salary',
    status: 'ok',
    results: [hit()],
    confidence: 0.91,
    elapsedMs: 12,
    sources: ['personal'],
  }, (line) => lines.push(line));
  assert.equal(lines.length, 0);
});

test('enabled diagnostics log metadata and never dump chunk text', async () => {
  process.env.NATIVELY_RAG_DIAGNOSTICS = '1';
  const { isRagDiagnosticsEnabled, buildRagDiagnosticEvent, recordRagSearch } = await import(pathToFileURL(diagPath).href);
  assert.equal(isRagDiagnosticsEnabled(), true);
  const event = buildRagDiagnosticEvent({
    originalQuery: 'what is my salary',
    retrievalQuery: 'salary compensation',
    status: 'ok',
    results: [hit()],
    confidence: 0.91,
    elapsedMs: 12,
    sources: ['personal'],
    skipped: false,
  });
  assert.equal(event.originalQuery, 'what is my salary');
  assert.equal(event.retrievalQuery, 'salary compensation');
  assert.equal(event.status, 'ok');
  assert.equal(event.hitCount, 1);
  assert.equal(event.elapsedMs, 12);
  assert.equal(event.hits[0].chunkId, 'c1');
  assert.equal(event.hits[0].documentName, 'comp.pdf');
  assert.equal(event.hits[0].pageStart, 4);
  assert.ok(!('text' in event.hits[0]));
  const dumped = JSON.stringify(event);
  assert.doesNotMatch(dumped, new RegExp(SECRET));
  const lines = [];
  recordRagSearch({
    originalQuery: 'what is my salary',
    retrievalQuery: 'salary compensation',
    status: 'ok',
    results: [hit()],
    confidence: 0.91,
    elapsedMs: 12,
    sources: ['personal'],
  }, (...args) => lines.push(args.join(' ')));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[RagDiagnostics\]/);
  assert.doesNotMatch(lines[0], new RegExp(SECRET));
  delete process.env.NATIVELY_RAG_DIAGNOSTICS;
});

test('RAGManager.search records diagnostics on every return', () => {
  const src = read('electron/rag/RAGManager.ts');
  const start = src.indexOf('async search(query: string');
  const end = src.indexOf('private isCanonicalRagComparisonEnabled', start);
  assert.ok(start >= 0 && end > start, 'could not locate search()');
  const body = src.slice(start, end);
  assert.match(body, /recordRagSearch\(/);
  assert.match(read('electron/rag/RagDiagnostics.ts'), /NATIVELY_RAG_DIAGNOSTICS/);
  assert.match(read('electron/rag/RagDiagnostics.ts'), /chunk\.text|SECRET|document content/i);
});
