import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const citationPath = path.join(root, 'dist-electron/electron/rag/RagCitation.js');
const builderPath = path.join(root, 'dist-electron/electron/rag/buildRagEvidencePack.js');

const hit = {
  chunk: {
    id: 'c1',
    documentId: 'd1',
    text: 'Q3 revenue was 12 million',
    chunkIndex: 0,
    pageStart: 4,
    pageEnd: 4,
    section: 'Results',
    heading: 'Revenue',
    metadata: {},
  },
  score: 0.9,
  source: { id: 'd1', sourceType: 'mode', name: 'report.pdf', metadata: {} },
};

test('same document+chunk yields the same citationId', async () => {
  const { buildStableRagCitation } = await import(pathToFileURL(citationPath).href);
  const a = buildStableRagCitation({
    documentId: 'd1',
    documentName: 'report.pdf',
    chunkId: 'c1',
    sourceType: 'mode',
    pageStart: 4,
    section: 'Results',
  });
  const b = buildStableRagCitation({
    documentId: 'd1',
    documentName: 'report.pdf',
    chunkId: 'c1',
    sourceType: 'mode',
  });
  assert.equal(a.citationId, b.citationId);
  assert.match(a.citationId, /^cite_mode_d1_c1$/);
  assert.equal(a.documentId, 'd1');
  assert.equal(a.chunkId, 'c1');
  assert.equal(a.pageStart, 4);
  assert.equal(a.section, 'Results');
});

test('search pack items carry the stable RagCitation, not a second type', async () => {
  const { buildRagEvidencePack } = await import(pathToFileURL(builderPath).href);
  const pack = buildRagEvidencePack({
    originalQuery: 'What was revenue in Q3?',
    retrievalQuery: 'Q3 revenue',
    status: 'ok',
    results: [hit],
  });
  assert.equal(pack.items[0].citation.citationId, 'cite_mode_d1_c1');
  assert.equal(pack.items[0].citation.documentName, 'report.pdf');
  assert.equal(pack.items[0].citation.pageStart, 4);
  assert.equal(pack.items[0].citation.section, 'Results');
  assert.equal(pack.items[0].citation.sourceType, 'mode');
  assert.doesNotMatch(read('electron/rag/RagCitation.ts'), /class .*Citation/);
  assert.doesNotMatch(read('electron/rag/buildRagEvidencePack.ts'), /interface .*Citation/);
});

test('EvidenceResolver and meeting mapper reuse buildStableRagCitation; Mode writers stay', () => {
  const resolver = read('electron/intelligence/context-os/EvidenceResolver.ts');
  assert.match(resolver, /buildStableRagCitation\(/);
  assert.doesNotMatch(resolver, /cite_\$\{turnId\}_hybrid_/);
  assert.doesNotMatch(resolver, /cite_\$\{turnId\}_okf_/);
  assert.match(read('electron/intelligence/context-os/meetingRagEvidence.ts'), /buildStableRagCitation\(/);
  const mode = read('electron/services/modes/ModeHybridRetriever.ts');
  assert.match(mode, /private updateIndexState\(/);
  assert.match(mode, /private removeIndexState\(/);
  assert.match(mode, /private ensureIndexTable\(/);
});
