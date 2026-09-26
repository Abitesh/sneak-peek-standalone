// Change 49 — WTA retrieval tests now pin the universal RAG boundary.
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
  assert.ok(elapsed < 5000, `universal RAG timeout must not block WTA; took ${elapsed}ms`);
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
  assert.match(source, /ragManager\.buildContext\(/);
  assert.doesNotMatch(source, /buildRetrievedActiveModeContextBlockHybrid\s*\(/);
  assert.doesNotMatch(source, /buildRetrievedActiveModeContextBlock\s*\(/);
  assert.doesNotMatch(source, /ModeRetrievalOptions/);
});
