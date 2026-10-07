import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const engineModule = await import('../../../../dist-electron/electron/intelligence/engine/NativelyIntelligenceEngine.js');
const retrievalModule = await import('../../../../dist-electron/electron/intelligence/engine/RetrievalCoordinator.js');
const { NativelyIntelligenceEngine } = engineModule;
const { RetrievalCoordinator, createRetrievalCapability } = retrievalModule;

function request(query, overrides = {}) {
  return {
    requestId: `change15-${Math.random().toString(36).slice(2)}`,
    sessionId: 'meeting-change15',
    surface: 'meeting-overlay',
    userMessage: query,
    currentTurn: { id: 'current', role: 'user', content: query },
    recentConversation: [],
    transcriptContext: {
      source: 'meeting',
      text: 'Interviewer: We decided to use Redis for caching because the hot path needs low latency.',
      turns: [
        { id: 't1', role: 'user', content: 'We decided to use Redis for caching because the hot path needs low latency.' },
      ],
    },
    activeContext: { meetingId: 'meeting-15' },
    contextPermissions: {
      conversation: true,
      transcript: true,
      screen: false,
      mode: false,
      project: true,
      profile: true,
      files: true,
      memory: true,
      generalKnowledge: true,
    },
    ...overrides,
  };
}

function makeEngine({ onRetrieve, onProvider, retrievalItems } = {}) {
  const retrieval = new RetrievalCoordinator({
    capabilities: [createRetrievalCapability('meeting_transcript', async ({ query }) => {
      onRetrieve?.(query);
      return {
        items: retrievalItems ?? [{
          id: 'meeting-evidence-1',
          source: 'meeting_transcript',
          content: 'The meeting decided to use Redis for caching because the hot path needs low latency.',
          score: 0.99,
          metadata: { meetingId: 'meeting-15', speaker: 'Interviewer' },
        }],
      };
    })],
  });

  return new NativelyIntelligenceEngine({
    retrievalCoordinator: retrieval,
    generationPort: {
      stream: async function* ({ prompt, lifecycle }) {
        onProvider?.(prompt.finalPrompt);
        lifecycle.transition('GENERATING', 'Change 15 test provider');
        yield 'The meeting chose Redis for low-latency caching.';
        lifecycle.transition('COMMITTED', 'Change 15 test first token');
        lifecycle.transition('COMPLETED', 'Change 15 test complete');
      },
    },
  });
}

test('meeting question uses transcript understanding, meeting retrieval, evidence, and one provider prompt', async () => {
  let retrievalCalls = 0;
  let providerPrompt = '';
  const engine = makeEngine({
    onRetrieve: () => { retrievalCalls += 1; },
    onProvider: (prompt) => { providerPrompt = prompt; },
  });

  const run = engine.prepareAndStream(request('What did they decide about Redis?'));
  const chunks = [];
  for await (const chunk of run.stream) chunks.push(chunk);
  const result = await run.result;

  assert.equal(run.lifecycle.state, 'COMPLETED');
  assert.equal(retrievalCalls, 1);
  assert.equal(result.contextPlan.requiredSources.includes('meeting_transcript'), true);
  assert.equal(result.evidence.items.length, 1);
  assert.match(result.prompt.finalPrompt, /The meeting decided to use Redis/);
  assert.equal(providerPrompt, result.prompt.finalPrompt);
  assert.equal(chunks.join(''), 'The meeting chose Redis for low-latency caching.');
});

test('general question during a meeting does not retrieve meeting evidence just because transcript is available', async () => {
  let retrievalCalls = 0;
  const engine = makeEngine({ onRetrieve: () => { retrievalCalls += 1; } });

  const run = engine.prepareAndStream(request('What is Redis?'));
  for await (const _chunk of run.stream) { /* consume */ }
  const result = await run.result;

  assert.equal(retrievalCalls, 0);
  assert.equal(result.contextPlan.requiredSources.includes('meeting_transcript'), false);
  assert.equal(result.evidence.items.length, 0);
  assert.doesNotMatch(result.prompt.finalPrompt, /The meeting decided to use Redis/);
});

test('meeting/live IPC handlers no longer invoke RAGManager answer generation', () => {
  const ipc = read('ipcHandlers.ts');
  const meetingStart = ipc.indexOf("safeHandle(\n'rag:query-meeting'");
  const liveStart = ipc.indexOf("safeHandle('rag:query-live'");
  const globalStart = ipc.indexOf("safeHandle('rag:query-global'");
  assert.ok(meetingStart >= 0 && liveStart > meetingStart && globalStart > liveStart);

  const requestStart = ipc.indexOf('function buildNativelyMeetingRequest(');
  const helperStart = ipc.indexOf('async function streamNativelyMeetingAnswer(');
  const manualStart = ipc.indexOf('const _geminiChatStreamHandler = async (');
  const meetingBlock = ipc.slice(meetingStart, liveStart);
  const liveBlock = ipc.slice(liveStart, globalStart);
  const adapter = ipc.slice(requestStart, manualStart);
  assert.ok(requestStart >= 0 && helperStart > requestStart && manualStart > helperStart);
  const migrated = `${adapter}\n${meetingBlock}\n${liveBlock}`;
  assert.match(migrated, /createPrimaryManualNativelyEngine/);
  assert.match(migrated, /prepareAndStream/);
  assert.match(migrated, /transcriptContext/);
  assert.match(migrated, /meetingId/);
  assert.doesNotMatch(migrated, /ragManager\.queryMeeting\(/);
  assert.doesNotMatch(migrated, /buildRAGPrompt\(/);
  assert.doesNotMatch(migrated, /streamChatWithOutcome\(/);
});

test('live STOP aborts the migrated live-engine controller', () => {
  const ipc = read('ipcHandlers.ts');
  const stopStart = ipc.indexOf("safeOn('gemini-chat-stream-stop'");
  const stopEnd = ipc.indexOf("safeOn('natively-answer-stop'", stopStart);
  const stop = ipc.slice(stopStart, stopEnd);
  assert.match(stop, /activeRAGQueries/);
  assert.match(stop, /key\.startsWith\('live-'\)/);
  assert.match(stop, /controller\.abort\(\)/);
});


test('meeting IPC query keys retain meeting identity for STOP and supersession', () => {
  const ipc = read('ipcHandlers.ts');
  const helperStart = ipc.indexOf('async function streamNativelyMeetingAnswer(');
  const helperEnd = ipc.indexOf('const _geminiChatStreamHandler = async (', helperStart);
  const helper = ipc.slice(helperStart, helperEnd);
  assert.match(helper, /const queryKey = `\$\{streamMeta\.live \? 'live' : 'meeting'\}-\$\{meetingId\}-\$\{crypto\.randomUUID\(\)\}`/);
  assert.match(ipc, /key\.startsWith\(`meeting-\$\{meetingId\}-`\)/);
  assert.match(ipc, /key\.startsWith\('live-'\)/);
  assert.match(helper, /if \(!llmHelper\) return \{ success: false, fallback: true \}/);
});

test('manual and V3 meeting identity use the public IntelligenceManager metadata API', () => {
  const ipc = read('ipcHandlers.ts');
  assert.doesNotMatch(ipc, /getSessionTracker\?\.\(\)\?\.getMeetingMetadata/);
  assert.match(ipc, /getIntelligenceManager\?\.\(\)\?\.getMeetingMetadata\?\.\(\)\?\.id/);
});
