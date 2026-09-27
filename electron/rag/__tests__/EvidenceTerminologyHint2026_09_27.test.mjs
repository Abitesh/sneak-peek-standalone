// electron/rag/__tests__/EvidenceTerminologyHint2026_09_27.test.mjs
//
// Stage 8: ASR near-miss (e.g. "DVMS") + retrieved evidence ("DBMS") →
// non-authoritative terminology note in prompt construction.
// Never rewrite displayed raw transcript; never bake policy into EvidencePack.
//
// Run: npm run build:electron && node --test electron/rag/__tests__/EvidenceTerminologyHint2026_09_27.test.mjs

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const hintPath = path.join(root, 'dist-electron/electron/rag/evidenceTerminologyHint.js');
const builderPath = path.join(root, 'dist-electron/electron/rag/RagContextBuilder.js');
const packPath = path.join(root, 'dist-electron/electron/rag/buildRagEvidencePack.js');

const RAW_TRANSCRIPT = 'What is DVMS?';
const EVIDENCE_TEXT =
  'A DBMS (Database Management System) stores and queries structured data.';

describe('Stage 8: evidence-driven terminology hint', () => {
  test('DVMS query + DBMS evidence → non-authoritative note; raw transcript untouched', async () => {
    const {
      findEvidenceTerminologyHints,
      renderTerminologyHintXml,
    } = await import(pathToFileURL(hintPath).href);

    const rawCopy = RAW_TRANSCRIPT;
    const hints = findEvidenceTerminologyHints(RAW_TRANSCRIPT, [EVIDENCE_TEXT]);
    assert.equal(RAW_TRANSCRIPT, rawCopy, 'helper must not mutate the displayed transcript string');
    assert.equal(RAW_TRANSCRIPT, 'What is DVMS?', 'raw ASR text stays as spoken/typed');

    assert.ok(hints.length >= 1, 'expected at least one near-miss hint');
    assert.equal(hints[0].heard.toLowerCase(), 'dvms');
    assert.equal(hints[0].evidenceTerm.toLowerCase(), 'dbms');

    const note = renderTerminologyHintXml(hints);
    assert.match(note, /authority="non_authoritative"/);
    assert.match(note, /asr_near_miss|terminology_note/i);
    assert.match(note, /heard="DVMS"/i);
    assert.match(note, /evidence_term="DBMS"/i);
    assert.match(note, /Do NOT rewrite|displayed.*transcript/i);
    assert.doesNotMatch(note, /correct(ed)?_query|rewritten_query/i);
  });

  test('buildRagContext appends the note without mutating pack or query', async () => {
    const { buildRagEvidencePack } = await import(pathToFileURL(packPath).href);
    const { buildRagContext } = await import(pathToFileURL(builderPath).href);

    const pack = buildRagEvidencePack({
      originalQuery: RAW_TRANSCRIPT,
      retrievalQuery: RAW_TRANSCRIPT,
      status: 'ok',
      results: [{
        chunk: {
          id: 'c1', documentId: 'd1', text: EVIDENCE_TEXT,
          chunkIndex: 0, metadata: {},
        },
        score: 0.91,
        source: { id: 'd1', sourceType: 'personal', name: 'dbms-notes.md', metadata: {} },
      }],
    });
    const packBefore = JSON.stringify(pack);

    const { prompt } = buildRagContext({ pack });
    assert.equal(JSON.stringify(pack), packBefore, 'EvidencePack must stay free of retrieval/terminology policy');
    assert.equal(pack.originalQuery, RAW_TRANSCRIPT);
    assert.match(prompt, /<terminology_note[\s\S]*DVMS[\s\S]*DBMS/i);
    assert.match(prompt, /authority="non_authoritative"/);
    assert.match(prompt, /DBMS \(Database Management System\)/);
  });

  test('exact token already in evidence → no false hint', async () => {
    const { findEvidenceTerminologyHints } = await import(pathToFileURL(hintPath).href);
    const hints = findEvidenceTerminologyHints('What is DBMS?', [EVIDENCE_TEXT]);
    assert.equal(hints.length, 0);
  });

  test('no near-miss in evidence → empty note', async () => {
    const {
      findEvidenceTerminologyHints,
      renderTerminologyHintXml,
    } = await import(pathToFileURL(hintPath).href);
    const hints = findEvidenceTerminologyHints('What is DVMS?', [
      'Redis caching powers the personal knowledge index.',
    ]);
    assert.equal(hints.length, 0);
    assert.equal(renderTerminologyHintXml(hints), '');
  });

  test('source pins: helper + RagContextBuilder + composer; no EvidencePack policy field', () => {
    const hintSrc = read('electron/rag/evidenceTerminologyHint.ts');
    const builderSrc = read('electron/rag/RagContextBuilder.ts');
    const composerSrc = read('electron/context-intelligence/generation/prompt-composer.ts');
    const packSrc = read('electron/intelligence/context-os/evidencePack.ts');

    assert.match(hintSrc, /findEvidenceTerminologyHints/);
    assert.match(hintSrc, /levenshtein1/);
    assert.match(builderSrc, /renderTerminologyHintXml|findEvidenceTerminologyHints/);
    assert.match(composerSrc, /findEvidenceTerminologyHints|renderTerminologyHintMarkdown|terminology/);
    assert.doesNotMatch(packSrc, /terminologyHint|terminology_note|asr_near_miss/);
  });
});
