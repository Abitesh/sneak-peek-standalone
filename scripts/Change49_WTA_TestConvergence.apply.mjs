import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const suggestionPath = path.resolve(root, 'electron/llm/__tests__/suggestionPromptAssembly.test.mjs');
const hybridPath = path.resolve(root, 'electron/llm/__tests__/WtaHybridRetrievalBudget.test.mjs');

function replaceNamedTest(source, title, replacement) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`test\\('${escaped}', async \\(\\) => \\{[\\s\\S]*?\\n\\}\\);(?=\\n\\ntest\\(|\\n\\n$)`, 'm');
  if (!re.test(source)) throw new Error(`Target test not found: ${title}`);
  return source.replace(re, replacement.trim());
}

if (!fs.existsSync(suggestionPath) || !fs.existsSync(hybridPath)) {
  throw new Error('Expected WTA test files were not found. Run from repo root.');
}

let suggestion = fs.readFileSync(suggestionPath, 'utf8');
const suggestionOld1 = 'WhatToAnswerLLM sends mode context only through user content at runtime (LEGACY path, pinned via kill-switch)';
const suggestionOld2 = 'WhatToAnswerLLM v2 regime: untrusted retrieval stays OUT of the system prompt (default-on path)';

suggestion = replaceNamedTest(suggestion, suggestionOld1, `
test('WhatToAnswerLLM uses the universal RAG boundary for mode context (legacy prompt regime)', async () => {
  process.env.NATIVELY_PROMPT_SYSTEM_V2 = '0';
  try {
    const { WhatToAnswerLLM } = require(distWhatToAnswerPath);
    const calls = [];
    const ragCalls = [];
    const universalContext = 'UNIVERSAL_REFERENCE_CONTEXT_SENTINEL';

    const llmHelper = {
      getCapabilities: () => ({ outputBudgetTokens: 2000 }),
      getPromptTier: () => 'full',
      fitContextForCurrentModel: text => text,
      async *streamChat(...args) { calls.push(args); yield 'ok'; },
    };
    const modesManager = {
      getActiveModeSystemPromptSuffix: () => 'TRUSTED_MODE_SUFFIX_SENTINEL',
      buildRetrievedActiveModeContextBlockHybrid: () => { throw new Error('legacy hybrid retrieval must not be called'); },
      buildRetrievedActiveModeContextBlock: () => { throw new Error('legacy lexical retrieval must not be called'); },
      buildActiveModeContextBlock: () => { throw new Error('raw mode context must not be called'); },
    };
    const answerer = new WhatToAnswerLLM(llmHelper, modesManager);
    answerer.setRagManagerProvider(() => ({
      buildContext: async (query, options) => {
        ragCalls.push({ query, options });
        return {
          status: 'ok',
          manualContext: {
            items: [{ text: universalContext, sourceId: 'mode-reference-test' }],
          },
        };
      },
    }));

    const chunks = [];
    for await (const chunk of answerer.generateStream('CURRENT_TRANSCRIPT_SENTINEL')) chunks.push(chunk);

    assert.deepEqual(chunks, ['ok']);
    assert.equal(ragCalls.length, 1);
    assert.equal(calls.length, 1);
    const [message, _imagePaths, context, systemPromptOverride] = calls[0];
    assert.equal(context, undefined);
    assert.match(message, /UNIVERSAL_REFERENCE_CONTEXT_SENTINEL/);
    assert.match(message, /CURRENT_TRANSCRIPT_SENTINEL/);
    assert.doesNotMatch(systemPromptOverride, /UNIVERSAL_REFERENCE_CONTEXT_SENTINEL/);
    assert.match(systemPromptOverride, /TRUSTED_MODE_SUFFIX_SENTINEL/);
  } finally {
    delete process.env.NATIVELY_PROMPT_SYSTEM_V2;
  }
});`);

suggestion = replaceNamedTest(suggestion, suggestionOld2, `
test('WhatToAnswerLLM v2 keeps universal retrieved context out of the system prompt', async () => {
  delete process.env.NATIVELY_PROMPT_SYSTEM_V2;
  const { WhatToAnswerLLM } = require(distWhatToAnswerPath);
  const calls = [];
  const ragCalls = [];
  const universalContext = 'UNIVERSAL_REFERENCE_CONTEXT_SENTINEL';

  const llmHelper = {
    getCapabilities: () => ({ outputBudgetTokens: 2000 }),
    getPromptTier: () => 'full',
    fitContextForCurrentModel: text => text,
    async *streamChat(...args) { calls.push(args); yield 'ok'; },
  };
  const modesManager = {
    getActiveModeSystemPromptSuffix: () => 'TRUSTED_MODE_SUFFIX_SENTINEL',
    buildRetrievedActiveModeContextBlockHybrid: () => { throw new Error('legacy hybrid retrieval must not be called'); },
    buildRetrievedActiveModeContextBlock: () => { throw new Error('legacy lexical retrieval must not be called'); },
    buildActiveModeContextBlock: () => { throw new Error('raw mode context must not be called'); },
  };
  const answerer = new WhatToAnswerLLM(llmHelper, modesManager);
  answerer.setRagManagerProvider(() => ({
    buildContext: async (query, options) => {
      ragCalls.push({ query, options });
      return {
        status: 'ok',
        manualContext: {
          items: [{ text: universalContext, sourceId: 'mode-reference-test' }],
        },
      };
    },
  }));

  for await (const _ of answerer.generateStream('CURRENT_TRANSCRIPT_SENTINEL')) { /* drain */ }

  assert.equal(ragCalls.length, 1);
  assert.equal(calls.length, 1);
  const [message, _img, context, systemPromptOverride] = calls[0];
  assert.equal(context, undefined);
  assert.match(message, /UNIVERSAL_REFERENCE_CONTEXT_SENTINEL/);
  assert.match(message, /CURRENT_TRANSCRIPT_SENTINEL/);
  assert.match(systemPromptOverride, /<active_mode name="/);
  assert.doesNotMatch(systemPromptOverride, /UNIVERSAL_REFERENCE_CONTEXT_SENTINEL/);
  assert.doesNotMatch(systemPromptOverride, /## ACTIVE MODE\\n/);
});`);

fs.writeFileSync(suggestionPath, suggestion);

const hybrid = `// Change 49 — WTA retrieval tests now pin the universal RAG boundary.
// The old tests exercised WhatToAnswerLLM's retired direct Mode hybrid/lexical
// retrieval path. Those tests became false after Change 48. The latency contract
// still matters, but it now applies to the universal RAG boundary itself.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distWhatToAnswerPath = path.resolve(__dirname, '../../../dist-electron/electron/llm/WhatToAnswerLLM.js');
const sourcePath = path.resolve(__dirname, '../WhatToAnswerLLM.ts');
const require = createRequire(import.meta.url);

const makeLLMHelper = (calls) => ({
  getCapabilities: () => ({ outputBudgetTokens: 2000 }),
  getPromptTier: () => 'full',
  fitContextForCurrentModel: text => text,
  async *streamChat(...args) {
    calls.push(args);
    yield 'answer';
  },
});

const universalResponse = (text) => ({
  status: 'ok',
  manualContext: {
    items: [{ text, sourceId: 'mode-reference-test' }],
  },
});

test('WTA universal RAG retrieval is bounded and a hanging RAG call does NOT block the stream', async () => {
  const { WhatToAnswerLLM } = require(distWhatToAnswerPath);
  const calls = [];
  let ragCalls = 0;
  let legacyHybridUsed = false;
  let legacyLexicalUsed = false;

  const modesManager = {
    getActiveModeSystemPromptSuffix: () => '',
    buildRetrievedActiveModeContextBlockHybrid: () => { legacyHybridUsed = true; throw new Error('legacy hybrid retrieval must not be called'); },
    buildRetrievedActiveModeContextBlock: () => { legacyLexicalUsed = true; throw new Error('legacy lexical retrieval must not be called'); },
    buildActiveModeContextBlock: () => '',
  };

  const answerer = new WhatToAnswerLLM(makeLLMHelper(calls), modesManager);
  answerer.setRagManagerProvider(() => ({
    buildContext: async () => {
      ragCalls++;
      return new Promise(() => {});
    },
  }));

  const start = Date.now();
  const chunks = [];
  for await (const chunk of answerer.generateStream('CURRENT_TRANSCRIPT_SENTINEL')) chunks.push(chunk);
  const elapsed = Date.now() - start;

  assert.deepEqual(chunks, ['answer']);
  assert.equal(calls.length, 1);
  assert.equal(ragCalls, 1);
  assert.equal(legacyHybridUsed, false);
  assert.equal(legacyLexicalUsed, false);
  assert.ok(elapsed < 5000, \`universal RAG timeout must not block WTA; took \${elapsed}ms\`);
});

test('WTA uses a fast universal RAG result directly and never invokes legacy Mode retrieval', async () => {
  const { WhatToAnswerLLM } = require(distWhatToAnswerPath);
  const calls = [];
  let ragCalls = 0;
  let legacyHybridUsed = false;
  let legacyLexicalUsed = false;

  const modesManager = {
    getActiveModeSystemPromptSuffix: () => '',
    buildRetrievedActiveModeContextBlockHybrid: () => { legacyHybridUsed = true; throw new Error('legacy hybrid retrieval must not be called'); },
    buildRetrievedActiveModeContextBlock: () => { legacyLexicalUsed = true; throw new Error('legacy lexical retrieval must not be called'); },
    buildActiveModeContextBlock: () => '',
  };

  const answerer = new WhatToAnswerLLM(makeLLMHelper(calls), modesManager);
  answerer.setRagManagerProvider(() => ({
    buildContext: async () => {
      ragCalls++;
      return universalResponse('UNIVERSAL_RAG_CONTEXT_FAST');
    },
  }));

  const chunks = [];
  for await (const chunk of answerer.generateStream('CURRENT_TRANSCRIPT_SENTINEL')) chunks.push(chunk);

  assert.deepEqual(chunks, ['answer']);
  assert.equal(calls.length, 1);
  assert.equal(ragCalls, 1);
  assert.equal(legacyHybridUsed, false);
  assert.equal(legacyLexicalUsed, false);
  assert.match(calls[0][0], /UNIVERSAL_RAG_CONTEXT_FAST/);
  assert.match(calls[0][0], /CURRENT_TRANSCRIPT_SENTINEL/);
});

test('Change 48 WTA source contains one universal retrieval boundary and no normal direct Mode retrieval calls', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');
  assert.match(source, /ragManagerProvider/);
  assert.match(source, /ragManager\\.buildContext\\(/);
  assert.doesNotMatch(source, /buildRetrievedActiveModeContextBlockHybrid\\s*\\(/);
  assert.doesNotMatch(source, /buildRetrievedActiveModeContextBlock\\s*\\(/);
  assert.doesNotMatch(source, /ModeRetrievalOptions/);
});
`;
fs.writeFileSync(hybridPath, hybrid);

console.log('Change 49 WTA test convergence applied.');
console.log(`Updated: ${suggestionPath}`);
console.log(`Replaced: ${hybridPath}`);
