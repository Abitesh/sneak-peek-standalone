import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const ev = read('electron/llm/__tests__/EvidenceResolverWiringIdentity2026_07_12.test.mjs');
const wt = read('electron/llm/__tests__/WtaPrestreamOrdering2026_08_18.test.mjs');
const sp = read('electron/llm/__tests__/suggestionPromptAssembly.test.mjs');
const engine = read('electron/IntelligenceEngine.ts');
const helper = read('electron/LLMHelper.ts');

const must = (text, pattern, label) => {
  const ok = pattern instanceof RegExp
    ? pattern.test(text)
    : text.includes(pattern);
  if (!ok) throw new Error(`FAIL: ${label}`);
};

const mustNot = (text, pattern, label) => {
  const ok = pattern instanceof RegExp
    ? pattern.test(text)
    : text.includes(pattern);
  if (ok) throw new Error(`FAIL: ${label}`);
};

// EvidenceResolver convergence.
must(
  ev,
  /Universal RAG owns application retrieval/,
  'EvidenceResolver ungoverned contract',
);
must(
  ev,
  /assert\.equal\(hybridLegacyCalls\s*\+\s*lexicalLegacyCalls,\s*0/,
  'EvidenceResolver no legacy mode-injection retrieval',
);
mustNot(
  ev,
  /legacy retrieval \(hybrid or lexical\) must run/,
  'stale ungoverned legacy expectation',
);
mustNot(
  ev,
  /legacy retrieval must run when govern is false/,
  'stale govern:false legacy expectation',
);

// WTA prestream test must assert the new Universal RAG boundary.
// These are checks against the source of the test itself, so regex syntax
// must be matched as regex syntax rather than as a plain literal string.
must(
  wt,
  'this\\.retrieveUniversalModeContext\\(\\s*wtaPrefetchQuery,\\s*snapshotModeInfo\\?\\.id,\\s*\\{',
  'WTA test asserts Universal RAG prefetch boundary',
);
must(
  wt,
  'answerType:\\s*wtaPrefetchAnswerType,',
  'WTA test asserts provisional answerType',
);
must(
  wt,
  'tokenBudget:\\s*1800,',
  'WTA test asserts retrieval budget',
);
must(
  wt,
  'assert.doesNotMatch(modeKickBlock, /buildRetrievedActiveModeContextBlock(?:Hybrid)?\\(',
  'WTA test rejects legacy application-level retrieval',
);

// Verify the actual production implementation as well.
must(
  engine,
  /this\.retrieveUniversalModeContext\(\s*wtaPrefetchQuery,\s*snapshotModeInfo\?\.id,\s*\{/,
  'IntelligenceEngine uses Universal RAG for WTA prefetch',
);
must(
  engine,
  /answerType:\s*wtaPrefetchAnswerType,/,
  'IntelligenceEngine passes provisional answerType',
);
must(
  engine,
  /tokenBudget:\s*1800,/,
  'IntelligenceEngine preserves WTA retrieval budget',
);

// Suggestion test convergence.
must(
  sp,
  /retrieveUniversalModeContext/,
  'suggestion test contains Universal RAG boundary',
);
must(
  sp,
  'groundingInfo\\?\\.modeId',
  'suggestion test uses pinned grounding mode',
);
mustNot(
  sp,
  /buildRetrievedActiveModeContextBlock\(\s*lastQuestion/,
  'suggestion stale legacy retrieval assertion',
);

// LLMHelper universal retrieval seam.
must(
  helper,
  /this\.retrieveUniversalModeContext\(/,
  'LLMHelper retains Universal RAG retrieval seam',
);

console.log('Change 52 test-convergence verification passed.');
