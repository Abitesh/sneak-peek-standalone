// Change 44: meeting overlay queries were a second retrieval path
// (queryMeeting → RAGRetriever.retrieve) beside RAGManager.search.
// They now go through search() so ranking/gate/shadow stay one engine.
// Specialized retrievers remain behind adapters — do not delete them.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function extractMethod(src, name) {
  const re = new RegExp(`async \\*${name}\\s*\\(`);
  const m = re.exec(src);
  assert.ok(m, `could not locate ${name}`);
  const start = src.indexOf('{', m.index);
  let i = start + 1;
  let depth = 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(start, i);
}

const manager = read('electron/rag/RAGManager.ts');
const meeting = extractMethod(manager, 'queryMeeting');
const global = extractMethod(manager, 'queryGlobal');

test('queryMeeting retrieves through search, not a second RAGRetriever call', () => {
  assert.match(meeting, /this\.search\(/);
  assert.match(meeting, /selectedSources:\s*\[[^\]]*['"]meeting['"]/);
  assert.match(meeting, /forceDocumentGrounding:\s*true/);
  assert.match(meeting, /meetingId/);
  assert.doesNotMatch(meeting, /this\.retriever\.retrieve\(/);
  assert.match(meeting, /streamRagAnswer\(/);
});

test('queryGlobal retrieves through search, not retrieveGlobal', () => {
  assert.match(global, /this\.search\(/);
  assert.match(global, /selectedSources:\s*\[[^\]]*['"]meeting['"]/);
  assert.match(global, /forceDocumentGrounding:\s*true/);
  assert.doesNotMatch(global, /this\.retriever\.retrieveGlobal\(/);
  assert.match(global, /streamRagAnswer\(/);
});

test('specialized retrievers remain for adapters', () => {
  assert.ok(fs.existsSync(path.join(root, 'electron/rag/RAGRetriever.ts')));
  assert.ok(fs.existsSync(path.join(root, 'electron/services/modes/ModeHybridRetriever.ts')));
  assert.ok(fs.existsSync(path.join(root, 'electron/personalKnowledge/PersonalKnowledgeManager.ts')));
  assert.match(read('electron/rag/adapters/MeetingRagAdapter.ts'), /this\.retriever\.retrieve\(/);
});
