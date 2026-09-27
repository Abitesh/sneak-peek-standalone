import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync('electron/LLMHelper.ts', 'utf8');

assert.match(src, /private async retrieveUniversalModeContext\(/, 'Universal Mode RAG helper is missing');
assert.match(src, /private async retrieveUniversalChatContext\(/, 'Universal chat RAG helper is missing');
assert.match(src, /selectedSources:\s*\['mode-reference'\]/, 'Universal Mode RAG must be scoped to mode-reference');
assert.match(src, /allowedSources:\s*\['mode-reference'\]/, 'Universal Mode RAG must constrain allowed sources');
assert.match(src, /buildUniversalChatAllowedSources\s*\(/, 'chat helper must use shared allowlist');
assert.match(src, /generateSuggestion[\s\S]*retrieveUniversalChatContext\(/, 'suggestion retrieval must use planner-led chat RAG');
assert.match(src, /retrieveUniversalChatContext\(\s*message,\s*routeOptions\?\.pinnedModeId/, 'manual mode retrieval must use planner-led chat RAG');
assert.match(src, /retrieveManualDocumentGroundedContext\(\s*query/, 'document-grounded path must remain on mode-only helper');
assert.match(
  src,
  /private async resolveManualDocumentGroundedContextWithLegacyFallback\(/,
  '47ZF shared resolver (universal then legacy-once) is missing',
);

assert.doesNotMatch(src, /\.buildRetrievedActiveModeContextBlock\s*\(/, 'LLMHelper must not directly call legacy lexical mode retrieval');
// Legacy hybrid is allowed ONLY inside the 47ZF empty/throw fallback lambdas.
const hybridCalls = [...src.matchAll(/\.buildRetrievedActiveModeContextBlockHybrid\s*\(/g)];
assert.equal(
  hybridCalls.length,
  2,
  `expected exactly 2 legacy hybrid fallback call sites (stream + non-stream), got ${hybridCalls.length}`,
);
assert.doesNotMatch(src, /runHybridModeRetrieval\s*\(/, 'LLMHelper must not orchestrate legacy hybrid retrieval');
assert.doesNotMatch(src, /shouldUseHybridRetrieval\s*\(/, 'LLMHelper must not own legacy hybrid eligibility');

// The governed Context OS path is deliberately allowed to delegate through the
// ModesManager-owned raw hybrid seam. That is a lower-level EvidenceResolver
// dependency, not an application-level retrieval fallback.
assert.match(src, /hybridRetriever:\s*\{\s*retrieveHybrid:\s*\([^)]*\)\s*=>\s*modesMgr\.retrieveHybridRaw\(/s,
  'governed EvidenceResolver must retain the shared ModesManager hybrid seam');

// Change 50A / Stage 6 document-grounded manual paths stay on the shared resolver.
assert.match(
  src,
  /resolveManualDocumentGroundedContextWithLegacyFallback\(\s*message,\s*(?:groundingInfo\?\.modeId|pin),?\s*/s,
  'streaming and non-streaming document-grounded paths must use the 47ZF resolver',
);

console.log('Change 50B verification passed.');
