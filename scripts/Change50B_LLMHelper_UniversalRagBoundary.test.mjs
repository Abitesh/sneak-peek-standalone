import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync('electron/LLMHelper.ts', 'utf8');

assert.match(src, /private async retrieveUniversalModeContext\(/, 'Universal Mode RAG helper is missing');
assert.match(src, /selectedSources:\s*\['mode-reference'\]/, 'Universal Mode RAG must be scoped to mode-reference');
assert.match(src, /allowedSources:\s*\['mode-reference'\]/, 'Universal Mode RAG must constrain allowed sources');
assert.match(src, /modeId,\s*\n\s*excludeCustomContext,/, 'Universal Mode RAG must pass mode scope and custom-context policy');
assert.match(src, /generateSuggestion[\s\S]*retrieveUniversalModeContext\(/, 'suggestion retrieval must use Universal Mode RAG');
assert.match(src, /chatWithGemini[\s\S]*retrieveUniversalModeContext\(/, 'non-streaming manual mode retrieval must use Universal Mode RAG');
assert.match(src, /streamChat[\s\S]*retrieveUniversalModeContext\(/, 'streaming manual mode retrieval must use Universal Mode RAG');

assert.doesNotMatch(src, /\.buildRetrievedActiveModeContextBlock\s*\(/, 'LLMHelper must not directly call legacy lexical mode retrieval');
assert.doesNotMatch(src, /\.buildRetrievedActiveModeContextBlockHybrid\s*\(/, 'LLMHelper must not directly call legacy hybrid mode retrieval');
assert.doesNotMatch(src, /runHybridModeRetrieval\s*\(/, 'LLMHelper must not orchestrate legacy hybrid retrieval');
assert.doesNotMatch(src, /shouldUseHybridRetrieval\s*\(/, 'LLMHelper must not own legacy hybrid eligibility');

// The governed Context OS path is deliberately allowed to delegate through the
// ModesManager-owned raw hybrid seam. That is a lower-level EvidenceResolver
// dependency, not an application-level retrieval fallback.
assert.match(src, /hybridRetriever:\s*\{\s*retrieveHybrid:\s*\([^)]*\)\s*=>\s*modesMgr\.retrieveHybridRaw\(/s,
  'governed EvidenceResolver must retain the shared ModesManager hybrid seam');

// Change 50A document-grounded manual paths must remain on the same helper.
assert.match(src, /retrieveManualDocumentGroundedContext\(\s*message,\s*pin,?\s*\)/s,
  'streaming document-grounded manual path must remain on Universal RAG');

console.log('Change 50B verification passed.');
