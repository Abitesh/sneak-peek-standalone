import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const sourceRoot = repoRoot;

const files = [
  'electron/llm/__tests__/EvidenceResolverWiringIdentity2026_07_12.test.mjs',
  'electron/llm/__tests__/WtaPrestreamOrdering2026_08_18.test.mjs',
  'electron/llm/__tests__/suggestionPromptAssembly.test.mjs',
];

for (const rel of files) {
  const src = path.join(sourceRoot, rel);
  if (!fs.existsSync(src)) throw new Error(`Missing repository file: ${rel}`);
}

const replacements = new Map([
  [
    files[0],
    {
      old: [
        "assert.ok(hybridLegacyCalls + lexicalLegacyCalls > 0, 'legacy retrieval (hybrid or lexical) must run for an un-governed doc-grounded turn');",
        "assert.ok(hybridLegacyCalls + lexicalLegacyCalls > 0, 'legacy retrieval must run when govern is false');",
      ],
      neu: [
        "assert.equal(hybridLegacyCalls + lexicalLegacyCalls, 0, 'legacy mode-injection retrieval must not run for an un-governed turn; Universal RAG owns application retrieval');",
        "assert.equal(hybridLegacyCalls + lexicalLegacyCalls, 0, 'legacy mode-injection retrieval must not run when govern is false; Universal RAG owns application retrieval');",
      ],
    },
  ],
  [
    files[1],
    {
      old: [
`    assert.match(engineSrc,
      /buildRetrievedActiveModeContextBlockHybrid\\(\\s*wtaPrefetchQuery,\\s*preparedTranscript,/,
      'query slot = resolved question; transcript slot = prepared window');`,
`    assert.match(engineSrc,
      /buildRetrievedActiveModeContextBlockHybrid\\(\\s*wtaPrefetchQuery,\\s*preparedTranscript,\\s*1800,\\s*wtaPrefetchAnswerType,/);`,
      ],
      neu: [
`    assert.match(engineSrc,
      /this\\.retrieveUniversalModeContext\\(\\s*wtaPrefetchQuery,\\s*snapshotModeInfo\\?\\.id,\\s*\\{/,
      'prefetch must enter the Universal RAG boundary with the resolved question and pinned mode');
    const modeKickBlock = engineSrc.slice(kickMode, kickMode + 1200);
    assert.doesNotMatch(modeKickBlock, /buildRetrievedActiveModeContextBlock(?:Hybrid)?\\(/,
      'prefetch must not call the legacy application-level mode retrieval API');`,
`    const modeKickBlock = engineSrc.slice(kickMode, kickMode + 1200);
    assert.match(modeKickBlock,
      /answerType:\\s*wtaPrefetchAnswerType,/,
      'the Universal RAG prefetch must receive the provisional answerType');
    assert.match(modeKickBlock,
      /tokenBudget:\\s*1800,/,
      'the Universal RAG prefetch must preserve the 1800-token retrieval budget');`,
      ],
    },
  ],
  [
    files[2],
    {
      old: [
`  assert.match(generateSuggestionSource, /buildRetrievedActiveModeContextBlock\\(\\s*lastQuestion,/);
  assert.match(generateSuggestionSource, /retrieveAnswerType/);
  assert.match(generateSuggestionSource, /documentGroundedCustomModeActive/);`,
      ],
      neu: [
`  assert.match(generateSuggestionSource,
    /retrieveUniversalModeContext\\(\\s*lastQuestion,\\s*groundingInfo\\?\\.modeId,\\s*false,/);
  assert.doesNotMatch(generateSuggestionSource, /buildRetrievedActiveModeContextBlock(?:Hybrid)?\\(/);
  assert.match(generateSuggestionSource, /getActiveModeDocumentGroundingInfo/);`,
      ],
    },
  ],
]);

for (const rel of files) {
  const target = path.join(repoRoot, rel);
  let text = fs.readFileSync(target, 'utf8');

  if (rel === files[0]) {
    text = text.replace(
      "test('un-governed turn (no contextOsGeneration): legacy retrieval DOES run, EvidenceResolver is NEVER called'",
      "test('un-governed turn (no contextOsGeneration): EvidenceResolver is NEVER called and legacy mode-injection retrieval is not called'"
    );
    text = text.replace(
      "test('un-governed turn (govern: false): legacy retrieval DOES run, EvidenceResolver is NEVER called'",
      "test('un-governed turn (govern: false): EvidenceResolver is NEVER called and legacy mode-injection retrieval is not called'"
    );
    text = text.replace(
      "//   4. When Context-OS does NOT govern the turn (flag off), the legacy\n//      retrieval path DOES run and EvidenceResolver.resolve() is never\n//      called — proving the un-governed case is unaffected.",
      "//   4. When Context-OS does NOT govern the turn, EvidenceResolver.resolve()\n//      is never called and the old application-level mode-injection retrieval\n//      seam is never called — proving retrieval ownership stays outside this\n//      resolver-specific path after Universal RAG convergence."
    );
    text = text.replace(
      "// Any regression that deletes the wiring (like a524329 did) makes assertions\n// 1-3 fail immediately: the resolver spy count drops to 0, the legacy-path\n// spy fires instead, and evidencePack stays the pre-seeded `null`.",
      "// Any regression that deletes the wiring (like a524329 did) makes assertions\n// 1-3 fail immediately: the resolver spy count drops to 0, the governed\n// retrieval path can fall back incorrectly, and evidencePack stays the\n// pre-seeded `null`. Universal RAG ownership is guarded separately by the\n// Change-50/50B retrieval-boundary tests."
    );
  } else if (rel === files[1]) {
    text = text.replace(
      "// Source-level pins (same convention as WtaParallelPrestream.test.mjs):\n// these fail if the kicks are moved back above extraction or the query\n// reverts to the transcript blob.",
      "// Source-level pins (same convention as WtaParallelPrestream.test.mjs):\n// these fail if the kicks are moved back above extraction, the query reverts\n// to the transcript blob, or the prefetch bypasses the Universal RAG boundary."
    );
  } else if (rel === files[2]) {
    text = text.replace(
`  // Retrieved mode context is scoped by answer type. Since the 2026-06-27
  // document-grounded fix, generateSuggestion picks the answer type
  // conditionally ('document_grounded_suggestion' when the active mode is
  // document-grounded, else 'general_meeting_answer') and threads
  // forceDocumentGrounding through the retrievalOptions position. Assert the
  // call uses lastQuestion + the conditional retrieveAnswerType, not the old
  // hardcoded 'general_meeting_answer' literal.
  assert.match(generateSuggestionSource, /buildRetrievedActiveModeContextBlock\\(\\s*lastQuestion,/);
  assert.match(generateSuggestionSource, /retrieveAnswerType/);
  assert.match(generateSuggestionSource, /documentGroundedCustomModeActive/);`,
`  // Universal RAG owns document/source admission now. generateSuggestion
  // supplies the resolved lastQuestion plus the active mode id to the single
  // application-owned retrieval boundary; it must not call the legacy
  // ModesManager retrieval block directly.
  assert.match(generateSuggestionSource,
    /retrieveUniversalModeContext\\(\\s*lastQuestion,\\s*groundingInfo\\?\\.modeId,\\s*false,/);
  assert.doesNotMatch(generateSuggestionSource, /buildRetrievedActiveModeContextBlock(?:Hybrid)?\\(/);
  assert.match(generateSuggestionSource, /getActiveModeDocumentGroundingInfo/);`
    );
  }

  // Fail loudly if a replacement did not actually change the intended old contract.
  if (rel === files[0]) {
    if (text.includes("legacy retrieval (hybrid or lexical) must run") ||
        text.includes("legacy retrieval must run when govern is false")) {
      throw new Error(`Change 52 did not converge ${rel}`);
    }
  }
  if (rel === files[1] && text.includes('buildRetrievedActiveModeContextBlockHybrid(\\s*wtaPrefetchQuery')) {
    throw new Error(`Change 52 did not converge ${rel}`);
  }
  if (rel === files[2] && text.includes('buildRetrievedActiveModeContextBlock(\\s*lastQuestion')) {
    throw new Error(`Change 52 did not converge ${rel}`);
  }

  fs.writeFileSync(target, text);
}

console.log('Change 52 test-convergence patch applied.');
