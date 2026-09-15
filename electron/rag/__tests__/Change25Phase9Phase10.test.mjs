import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const ragManagerSource = fs.readFileSync(new URL('../RAGManager.ts', import.meta.url), 'utf8');
const personalManagerSource = fs.readFileSync(new URL('../../personalKnowledge/PersonalKnowledgeManager.ts', import.meta.url), 'utf8');
const modeHybridSource = fs.readFileSync(new URL('../../services/modes/ModeHybridRetriever.ts', import.meta.url), 'utf8');
const liveIndexerSource = fs.readFileSync(new URL('../LiveRAGIndexer.ts', import.meta.url), 'utf8');
const flagsSource = fs.readFileSync(new URL('../../intelligence/intelligenceFlags.ts', import.meta.url), 'utf8');

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

test('Phase 9 reuses canonicalRagRead instead of inventing a second write flag', () => {
  assert.match(flagsSource, /export function shouldWriteLegacyRagChunks/);
  assert.match(flagsSource, /return !isIntelligenceFlagEnabled\('canonicalRagRead'\)/);
  assert.doesNotMatch(flagsSource, /canonicalRagStopLegacyWrites/);
});

test('Phase 9 writes canonical-first from in-memory chunks when canonical reads are on', () => {
  const indexDocument = extractMethod(ragManagerSource, 'async indexDocument(');
  assert.match(indexDocument, /if \(!shouldWriteLegacyRagChunks\(\)\)/);
  assert.match(indexDocument, /await this\.indexCanonicalCorpus\(/);
  assert.match(indexDocument, /falling back to legacy writes/);
  assert.match(ragManagerSource, /wroteLegacyChunks/);
  assert.match(ragManagerSource, /this\.vectorStore\.saveChunks\(chunks\)/);
});

test('Phase 9 keeps dual-write when canonical reads are off', () => {
  const indexDocument = extractMethod(ragManagerSource, 'async indexDocument(');
  assert.match(indexDocument, /this\.modeStorage\.replaceChunks/);
  assert.match(indexDocument, /this\.personalStorage\.replaceChunks/);
  assert.match(indexDocument, /await this\.projectModeFileCanonical\(documentId\)/);
  assert.match(ragManagerSource, /await this\.projectMeetingCanonical\(meetingId\)/);
});

test('Phase 10 skips obsolete Mode persistChunks and Personal dual-write projection when canonical reads are on', () => {
  const persistChunks = extractMethod(modeHybridSource, 'private persistChunks(');
  assert.match(persistChunks, /if \(!shouldWriteLegacyRagChunks\(\)\) return;/);
  assert.match(personalManagerSource, /if \(shouldWriteLegacyRagChunks\(\)\) \{/);
  assert.match(personalManagerSource, /await this\.ragManager\.projectPersonalFileCanonical\(id\)/);
});

test('Phase 10 does not delete legacy tables, adapters, or live meeting writes', () => {
  assert.match(liveIndexerSource, /this\.vectorStore\.saveChunks/);
  assert.doesNotMatch(ragManagerSource, /DROP TABLE mode_reference_chunks/);
  assert.doesNotMatch(ragManagerSource, /DROP TABLE personal_file_chunks/);
  assert.doesNotMatch(ragManagerSource, /DROP TABLE chunks/);
  assert.match(ragManagerSource, /from '\.\/adapters\/ModeRagAdapter'/);
  assert.match(ragManagerSource, /from '\.\/adapters\/PersonalRagAdapter'/);
  assert.match(ragManagerSource, /from '\.\/adapters\/MeetingRagAdapter'/);
});
