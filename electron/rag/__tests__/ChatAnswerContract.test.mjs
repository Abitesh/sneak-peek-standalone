import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const contractPath = path.join(root, 'dist-electron/electron/rag/chatAnswerContract.js');
const citationPath = path.join(root, 'dist-electron/electron/rag/RagCitation.js');

const SECRET = 'SECRET_PAYROLL_SSN_999-99-9999';

test('toChatAnswerContract is { text, citations, ragUsed?, confidence?, sources? }', async () => {
  const { toChatAnswerContract, chatAnswerIpcFields } = await import(pathToFileURL(contractPath).href);
  const citations = {
    S1: {
      marker: 'S1',
      evidenceId: 'ev-1',
      citationId: 'cite_mode_d1_c1',
      citation: {
        citationId: 'cite_mode_d1_c1',
        documentId: 'd1',
        documentName: 'report.pdf',
        chunkId: 'c1',
        pageStart: 4,
        section: 'Results',
        sourceType: 'mode',
      },
    },
  };
  const contract = toChatAnswerContract({
    text: 'Revenue was 12 million [S1].',
    citations,
    ragUsed: true,
    confidence: 0.91,
  });
  assert.equal(contract.text, 'Revenue was 12 million [S1].');
  assert.equal(contract.citations, citations);
  assert.equal(contract.ragUsed, true);
  assert.equal(contract.confidence, 0.91);
  assert.deepEqual(contract.sources, ['report.pdf']);

  const ipc = chatAnswerIpcFields(contract);
  assert.equal(ipc.text, contract.text);
  assert.equal(ipc.citations, citations);
  assert.equal(ipc.citationMarkers, citations);
  assert.equal(ipc.ragUsed, true);
  const dumped = JSON.stringify(ipc);
  assert.doesNotMatch(dumped, /chunk\.text|"content":/);
});

test('empty citations do not fake RAG use or citationMarkers', async () => {
  const { toChatAnswerContract, chatAnswerIpcFields } = await import(pathToFileURL(contractPath).href);
  const contract = toChatAnswerContract({ text: 'A mutex is a lock.' });
  assert.equal(contract.ragUsed, false);
  assert.deepEqual(contract.citations, {});
  const ipc = chatAnswerIpcFields(contract);
  assert.equal(ipc.ragUsed, false);
  assert.ok(!('citationMarkers' in ipc));
  assert.ok(!('sources' in ipc));
});

test('packed evidence markers never include document text', async () => {
  const { citationMarkersForEvidenceItems } = await import(pathToFileURL(citationPath).href);
  const markers = citationMarkersForEvidenceItems([{
    evidenceId: 'ev-1',
    sourceId: 'd1',
    documentTitle: 'comp.pdf',
    sourceType: 'REFERENCE_FILE',
    metadata: { pageStart: 4, section: 'Payroll' },
    content: SECRET,
  }]);
  assert.equal(markers.S1.citation.documentName, 'comp.pdf');
  assert.equal(markers.S1.citation.pageStart, 4);
  assert.equal(markers.S1.citation.section, 'Payroll');
  const dumped = JSON.stringify(markers);
  assert.doesNotMatch(dumped, new RegExp(SECRET));
  assert.ok(!('text' in markers.S1));
  assert.ok(!('content' in markers.S1));
  assert.ok(!('text' in markers.S1.citation));
});

test('V3 and legacy gemini-stream-done send the unified chat answer contract', () => {
  const ipc = read('electron/ipcHandlers.ts');
  const start = ipc.indexOf('const _geminiChatStreamHandler');
  const end = ipc.indexOf("safeHandle('gemini-chat-stream'", start);
  assert.ok(start >= 0 && end > start);
  const handler = ipc.slice(start, end);
  assert.match(handler, /toChatAnswerContract\(/);
  assert.match(handler, /chatAnswerIpcFields\(/);

  const v3Done = /send\('gemini-stream-done',\s*\{\s*finalText,\s*streamId: myStreamId/.exec(handler);
  assert.ok(v3Done, 'V3 done payload must still open with finalText, streamId');
  const v3Slice = handler.slice(v3Done.index, v3Done.index + 900);
  assert.match(v3Slice, /chatAnswerIpcFields\(/);
  assert.match(v3Slice, /composed\.citationMarkers/);
  assert.match(v3Slice, /composed\.evidenceCount > 0/);

  const legacyDone = /send\('gemini-stream-done',\s*\{\s*\.\.\.\(finalText \? \{ finalText \} : \{\}\),\s*streamId: myStreamId/.exec(handler);
  assert.ok(legacyDone, 'legacy done payload must still open with conditional finalText + streamId');
  assert.match(handler.slice(legacyDone.index, legacyDone.index + 250), /chatAnswerIpcFields\(/);
});

test('engine-bridge exposes packed citation identity; packer stamps matching S-markers', () => {
  const bridge = read('electron/context-intelligence/orchestration/engine-bridge.ts');
  assert.match(bridge, /citationMarkersForEvidenceItems\(/);
  assert.match(bridge, /includedEvidenceIds/);
  assert.doesNotMatch(bridge, /content: e\.content|chunk\.text/);
  const packer = read('electron/context-intelligence/generation/context-packer.ts');
  assert.match(packer, /citation_marker=/);
  const composer = read('electron/context-intelligence/generation/prompt-composer.ts');
  assert.match(composer, /\[S1\]/);
});
