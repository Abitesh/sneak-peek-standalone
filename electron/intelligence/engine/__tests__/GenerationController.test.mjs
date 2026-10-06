import test from 'node:test';
import assert from 'node:assert/strict';
import { GenerationController } from '../GenerationController.js';

function route(overrides = {}) {
  return {
    capability: 'stream_chat',
    availability: { hasGroq: true, hasGemini: true },
    models: { groq: 'qwen/qwen3.8-27b', geminiFlash: 'gemini-3.7-flash' },
    ...overrides,
  };
}

async function collect(stream) {
  let text = '';
  for await (const chunk of stream) text += chunk;
  return text;
}

test('pre-first-token provider failure falls back and emits only one final answer', async () => {
  const calls = [];
  const transport = {
    async *streamFinalPrompt(provider, model, finalPrompt) {
      calls.push({ provider, model, finalPrompt });
      if (provider === 'groq') throw new Error('Gemini/Groq unavailable before first token');
      yield 'fallback answer';
    },
  };

  const controller = new GenerationController(transport);
  const { stream, outcome } = controller.stream({
    requestId: 'r1',
    finalPrompt: '<final_prompt>What is Redis?</final_prompt>',
    route: route(),
  });

  assert.equal(await collect(stream), 'fallback answer');
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.lifecycle.state, 'COMPLETED');
  assert.deepEqual(outcome.lifecycle.history.map((entry) => entry.state), ['IDLE', 'GENERATING', 'COMMITTED', 'COMPLETED']);
  assert.equal(outcome.fallbackUsed, true);
  assert.equal(outcome.committedProvider, 'gemini_flash');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].finalPrompt, calls[1].finalPrompt);
});

test('post-commit provider failure never appends a second provider answer', async () => {
  const calls = [];
  const transport = {
    async *streamFinalPrompt(provider) {
      calls.push(provider);
      yield 'partial answer';
      throw new Error('connection dropped after first token');
    },
  };

  const controller = new GenerationController(transport);
  const { stream, outcome } = controller.stream({
    requestId: 'r2',
    finalPrompt: 'final prompt',
    route: route(),
  });

  assert.equal(await collect(stream), 'partial answer');
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.lifecycle.state, 'FAILED');
  assert.equal(outcome.fallbackUsed, false);
  assert.equal(calls.length, 1);
  assert.match(outcome.error, /after commit/i);
});

test('first visible token establishes provider commit and first-token timing', async () => {
  const transport = {
    async *streamFinalPrompt() {
      yield 'hello';
      yield ' world';
    },
  };

  const controller = new GenerationController(transport);
  const { stream, outcome } = controller.stream({
    requestId: 'r3',
    finalPrompt: 'final prompt',
    route: route({ maxAttempts: 1 }),
  });

  assert.equal(await collect(stream), 'hello world');
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.firstTokenAt !== undefined, true);
  assert.equal(outcome.firstTokenLatencyMs !== undefined, true);
  assert.equal(outcome.committedProvider, 'groq');
  assert.equal(outcome.attempts[0].status, 'succeeded');
  assert.equal(outcome.attempts[0].firstTokenAt !== undefined, true);
});

test('abort before generation produces no provider call', async () => {
  const calls = [];
  const controller = new GenerationController({
    async *streamFinalPrompt() {
      calls.push('called');
      yield 'should not happen';
    },
  });

  const abort = new AbortController();
  abort.abort();
  const { stream, outcome } = controller.stream({
    requestId: 'r4',
    finalPrompt: 'final prompt',
    route: route(),
    abortSignal: abort.signal,
  });

  assert.equal(await collect(stream), '');
  assert.equal(outcome.status, 'cancelled');
  assert.equal(calls.length, 0);
});

test('cancellation during streaming stops output without fallback', async () => {
  const abort = new AbortController();
  const calls = [];
  const transport = {
    async *streamFinalPrompt(provider, _model, _prompt, options) {
      calls.push(provider);
      yield 'first';
      abort.abort();
      yield 'second';
    },
  };

  const controller = new GenerationController(transport);
  const { stream, outcome } = controller.stream({
    requestId: 'r5',
    finalPrompt: 'final prompt',
    route: route(),
    abortSignal: abort.signal,
  });

  assert.equal(await collect(stream), 'first');
  assert.equal(outcome.status, 'cancelled');
  assert.equal(outcome.lifecycle.state, 'CANCELLED');
  assert.equal(calls.length, 1);
});

test('unavailable providers are skipped by the generation controller', async () => {
  const calls = [];
  const controller = new GenerationController({
    async *streamFinalPrompt(provider) {
      calls.push(provider);
      yield 'answer';
    },
  });

  const { stream, outcome } = controller.stream({
    requestId: 'r6',
    finalPrompt: 'final prompt',
    route: {
      capability: 'stream_chat',
      availability: { hasGroq: false, hasGemini: true },
      models: { geminiFlash: 'gemini-3.7-flash' },
      preferredProvider: 'groq',
    },
  });

  assert.equal(await collect(stream), 'answer');
  assert.deepEqual(calls, ['gemini_flash']);
  assert.equal(outcome.committedProvider, 'gemini_flash');
});
