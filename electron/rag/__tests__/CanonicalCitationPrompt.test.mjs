import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const rendererPath = path.join(root, 'dist-electron/electron/intelligence/context-os/promptRenderer.js');
const builderPath = path.join(root, 'dist-electron/electron/rag/buildRagEvidencePack.js');

const contract = {
  turnId: 't1',
  surface: 'manual_chat',
  sourceOwner: 'reference_files',
  answerShape: 'list',
  requestedProperty: 'unknown',
  voicePerspective: 'assistant_explanation',
  conflictPolicy: 'prefer_source_owner',
  forbiddenSources: [],
  referentOnlySources: [],
};

test('search pack prompt has SOURCES markers and forbids invented citations', async () => {
  const { buildRagEvidencePack } = await import(pathToFileURL(builderPath).href);
  const { renderContextOsPromptPrefix } = await import(pathToFileURL(rendererPath).href);
  const pack = buildRagEvidencePack({
    originalQuery: 'What was revenue in Q3?',
    retrievalQuery: 'Q3 revenue',
    status: 'ok',
    results: [{
      chunk: {
        id: 'c1', documentId: 'd1', text: 'Q3 revenue was 12 million',
        chunkIndex: 0, pageStart: 4, section: 'Results', metadata: {},
      },
      score: 0.9,
      source: { id: 'd1', sourceType: 'mode', name: 'report.pdf', metadata: {} },
    }],
  });
  const prompt = renderContextOsPromptPrefix(contract, pack);
  assert.match(prompt, /<SOURCES>/);
  assert.match(prompt, /\[S1\]/);
  assert.match(prompt, /Never invent, modify, renumber, or guess citation markers/);
  assert.match(prompt, /citation_marker="S1"/);
  assert.match(prompt, /Document: report\.pdf/);
  assert.match(prompt, /Page: 4/);
});

test('evidence without a prebuilt citation still gets a marker; empty pack does not invite citations', async () => {
  const { renderContextOsPromptPrefix, renderEvidencePackWithManifest } = await import(pathToFileURL(rendererPath).href);
  const item = {
    evidenceId: 'e1',
    sourceKind: 'mode_reference_chunk',
    sourceId: 'f1',
    sourceOwner: 'reference_files',
    authority: 'evidence',
    trustLevel: 'user_uploaded',
    text: 'Working Voltage: 24 V',
    documentId: 'f1',
    documentName: 'spec.pdf',
    chunkId: 'f1:0',
    pageStart: 17,
    sourceType: 'mode',
    supports: { property: 'unknown' },
    score: { final: 0.9 },
    reasonIncluded: 'test',
  };
  const filled = renderEvidencePackWithManifest({
    packId: 'p1', turnId: 't1', sourceOwner: 'reference_files', requestedProperty: 'unknown',
    items: [item], rejected: [], coverage: { hasDirectEvidence: true, propertySatisfied: true, entityMatched: true, sourceOwnerSatisfied: true, confidence: 0.9 },
    conflicts: [], answerPolicy: 'answer',
  });
  assert.match(filled.prompt, /<SOURCES>/);
  assert.equal(Object.keys(filled.manifest.citationMarkers)[0], 'S1');

  const bridged = renderEvidencePackWithManifest({
    packId: 'p2', turnId: 't1', sourceOwner: 'reference_files', requestedProperty: 'unknown',
    items: [{
      evidenceId: 'e2',
      sourceKind: 'mode_reference_chunk',
      sourceId: 'thesis-1',
      sourceOwner: 'reference_files',
      authority: 'evidence',
      trustLevel: 'user_uploaded',
      text: 'The methodology uses interviews.',
      pointer: { fileId: 'thesis-1', chunkId: 'thesis-1:0', section: 'thesis.pdf' },
      supports: { property: 'unknown' },
      score: { final: 0.8 },
      reasonIncluded: 'document evidence (typed pack governs prompt)',
    }],
    rejected: [], coverage: { hasDirectEvidence: true, propertySatisfied: true, entityMatched: true, sourceOwnerSatisfied: true, confidence: 0.8 },
    conflicts: [], answerPolicy: 'answer',
  });
  assert.match(bridged.prompt, /Document: thesis\.pdf/);

  const empty = renderContextOsPromptPrefix(contract, {
    packId: 'p0', turnId: 't1', sourceOwner: 'reference_files', requestedProperty: 'unknown',
    items: [], rejected: [], coverage: { hasDirectEvidence: false, propertySatisfied: false, entityMatched: false, sourceOwnerSatisfied: true, confidence: 0 },
    conflicts: [], answerPolicy: 'refuse_insufficient_evidence',
  });
  assert.doesNotMatch(empty, /<SOURCES>/);
  assert.doesNotMatch(empty, /citation_use_contract/);
});

test('LLMHelper path reuses PromptRenderer; no second CitationBuilder; Mode writers stay', () => {
  assert.match(read('electron/intelligence/context-os/generationContext.ts'), /renderCitationUseRule\(/);
  assert.match(read('electron/LLMHelper.ts'), /renderGoverningFactualBlock\(/);
  assert.match(read('electron/intelligence/context-os/renderedEvidenceManifest.ts'), /citationForEvidenceItem\(/);
  assert.doesNotMatch(read('electron/intelligence/context-os/promptRenderer.ts'), /class CitationBuilder/);
  const mode = read('electron/services/modes/ModeHybridRetriever.ts');
  assert.match(mode, /private updateIndexState\(/);
  assert.match(mode, /private removeIndexState\(/);
  assert.match(mode, /private ensureIndexTable\(/);
});
