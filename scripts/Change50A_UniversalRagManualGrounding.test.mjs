#!/usr/bin/env node
import fs from 'node:fs';
import assert from 'node:assert/strict';

const p = 'electron/LLMHelper.ts';
assert.ok(fs.existsSync(p), `${p} not found`);
const s = fs.readFileSync(p, 'utf8');

// Change 50A / Stage 6: Universal RAG owns application-level manual document
// grounding. Legacy hybrid remains a one-shot empty/throw fallback via the
// shared 47ZF resolver — not an always-on parallel path.
assert.ok(
  s.includes('private async resolveManualDocumentGroundedContextWithLegacyFallback('),
  'Change 50A/Stage 6: 47ZF resolve helper with legacy fallback missing',
);
assert.ok(
  s.includes('private async retrieveManualDocumentGroundedContext('),
  'Change 50A: retrieveManualDocumentGroundedContext helper missing',
);
assert.ok(
  s.includes('const ragManager = this.ragManagerProvider?.();'),
  'Change 50A: LLMHelper RAG manager provider missing',
);
assert.ok(
  s.includes("selectedSources: ['mode-reference']"),
  'Change 50A: manual RAG source selection missing',
);

// Streaming + non-streaming document-grounded sites must use the shared resolver.
const resolveCalls = s.match(/this\.resolveManualDocumentGroundedContextWithLegacyFallback\(/g) || [];
assert.equal(
  resolveCalls.length,
  2,
  `expected streaming + non-streaming 47ZF resolve call sites, got ${resolveCalls.length}`,
);

// Governed EvidenceResolver still uses ModesManager's raw hybrid seam.
assert.ok(
  s.includes('hybridRetriever: { retrieveHybrid: (m: any, files: any, opts: any) => modesMgr.retrieveHybridRaw(m, files, opts) }'),
  'Change 50A: governed EvidenceResolver singleton retrieval wiring unexpectedly removed',
);

console.log('Change 50A verification passed.');
