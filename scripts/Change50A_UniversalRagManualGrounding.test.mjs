#!/usr/bin/env node
import fs from 'node:fs';
import assert from 'node:assert/strict';

const p = 'electron/LLMHelper.ts';
assert.ok(fs.existsSync(p), `${p} not found`);
const s = fs.readFileSync(p, 'utf8');

// Change 50A: Universal RAG owns application-level manual document grounding.
// The two old "RAG first, ModesManager hybrid if empty" fallbacks must be gone.
assert.equal(
  s.includes('.buildRetrievedActiveModeContextBlockHybrid(message, undefined, undefined, undefined, true);'),
  false,
  'Change 50A: non-streaming manual document grounding still has a legacy hybrid fallback',
);
assert.equal(
  s.includes('.buildRetrievedActiveModeContextBlockHybrid(message, undefined, undefined, undefined, true, pin);'),
  false,
  'Change 50A: streaming manual document grounding still has a legacy hybrid fallback',
);

// The canonical application-owned RAG boundary must remain.
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

// These are intentionally NOT removed in Change 50A.
// They serve active-mode injection / governed execution responsibilities and
// require a separate convergence decision.
assert.ok(
  s.includes('modeContextBlock = modesMgr.buildRetrievedActiveModeContextBlock('),
  'Change 50A: active-mode injection path unexpectedly removed',
);
assert.ok(
  s.includes('hybridRetriever: { retrieveHybrid: (m: any, files: any, opts: any) => modesMgr.retrieveHybridRaw(m, files, opts) }'),
  'Change 50A: governed EvidenceResolver singleton retrieval wiring unexpectedly removed',
);

// Ensure the legacy fallback removal did not accidentally remove all hybrid
// retrieval from LLMHelper. The governed/internal and active-mode paths remain.
assert.ok(
  s.includes('runHybridModeRetrieval(modesMgr'),
  'Change 50A: shared hybrid retrieval path unexpectedly removed',
);

console.log('Change 50A verification passed.');
