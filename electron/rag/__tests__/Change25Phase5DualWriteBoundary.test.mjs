import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const ragManagerSource = fs.readFileSync(new URL('../RAGManager.ts', import.meta.url), 'utf8');
const personalManagerSource = fs.readFileSync(new URL('../../personalKnowledge/PersonalKnowledgeManager.ts', import.meta.url), 'utf8');

function extractMethod(source, methodName) {
  const start = source.indexOf(methodName);
  assert.notEqual(start, -1, `Expected ${methodName} to exist`);
  const bodyStart = source.indexOf('{', start);
  assert.notEqual(bodyStart, -1, `Expected ${methodName} to have a body`);

  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }

  assert.fail(`Expected ${methodName} body to close`);
}

test('Phase 5 keeps Mode canonical projection at the normal RAGManager.indexDocument boundary', () => {
  assert.match(ragManagerSource, /if \(input\.sourceType === 'mode' && status === 'ready'\)/);
  assert.match(ragManagerSource, /await this\.projectModeFileCanonical\(documentId\)/);
  assert.match(ragManagerSource, /Canonical Mode projection failed; legacy indexing remains successful/);
  const projectionBoundary = extractMethod(ragManagerSource, 'async projectModeFileCanonical(');
  const indexDocument = extractMethod(ragManagerSource, 'async indexDocument(');
  assert.doesNotMatch(projectionBoundary, /ModeHybridRetriever/);
  assert.doesNotMatch(indexDocument, /ModeHybridRetriever/);
});

test('Phase 5 keeps Meeting canonical projection after persisted chunks and excludes live meetings in the projection service', () => {
  assert.match(ragManagerSource, /this\.vectorStore\.saveChunks\(chunks\);/);
  assert.match(ragManagerSource, /await this\.projectMeetingCanonical\(meetingId\)/);
  assert.match(ragManagerSource, /Canonical meeting projection failed; legacy meeting RAG remains successful/);
  const meetingProjectionBoundary = extractMethod(ragManagerSource, 'async projectMeetingCanonical(');
  const processMeeting = extractMethod(ragManagerSource, 'async processMeeting(');
  assert.doesNotMatch(meetingProjectionBoundary, /LiveRAGIndexer/);
  assert.doesNotMatch(processMeeting, /LiveRAGIndexer/);
  assert.doesNotMatch(processMeeting, /projectMeetingCanonical[\s\S]*LiveRAGIndexer/);
});

test('Phase 5 repairs canonical Personal projection on duplicate-content early return', () => {
  assert.match(personalManagerSource, /if \(existing\?\.id\) \{/);
  assert.match(personalManagerSource, /await this\.ragManager\.projectPersonalFileCanonical\(existing\.id\)/);
  assert.match(personalManagerSource, /Canonical personal RAG repair failed for existing file/);
});

test('Phase 5 does not add destructive canonical deletion', () => {
  assert.doesNotMatch(ragManagerSource, /delete.*Canonical.*Personal|delete.*Canonical.*Mode|delete.*Canonical.*Meeting/i);
  assert.doesNotMatch(personalManagerSource, /delete.*Canonical/i);
});
