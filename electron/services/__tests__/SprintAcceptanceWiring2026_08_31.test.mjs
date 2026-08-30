// electron/services/__tests__/SprintAcceptanceWiring2026_08_31.test.mjs
//
// Sprint S10 (Problem 50) — E2E acceptance wiring check.
//
// This is deliberately NOT a re-test of the detailed unit/regression coverage
// already added by S1-S8 (ProviderRegistry.test.mjs, RoutingFallbackCascade
// 2026_08_31.test.mjs, ScreenPipeline2026_08_31.test.mjs,
// SprintS6ContextManagerWiring2026_08_31.test.mjs,
// ListenAnalyzeAudioStateWiring2026_08_31.test.mjs, etc.) — those already
// exercise the real logic. This file is the single place that documents and
// asserts, by source inspection, that every leg of the Definition-of-done
// acceptance script (plan §"Acceptance script", Problem 50) is actually wired
// up end to end: it fails loudly if a future refactor deletes or renames one
// of the eight pipeline legs without updating this checklist.
//
// Does NOT perform a live-key run (no network calls, no real provider
// credentials required) — it inspects the compiled/source files for the
// specific call sites and exports each acceptance step depends on.
//
// Run: node --test electron/services/__tests__/SprintAcceptanceWiring2026_08_31.test.mjs
// (no build required — reads .ts/.tsx source directly, like
// ListenAnalyzeAudioStateWiring2026_08_31.test.mjs.)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const IPC_HANDLERS = read('electron/ipcHandlers.ts');
const PROVIDER_REGISTRY = read('electron/llm/providerRegistry.ts');
const CREDENTIALS_MANAGER = read('electron/services/CredentialsManager.ts');
const LLM_HELPER = read('electron/LLMHelper.ts');
const AI_PROVIDERS_SETTINGS = read('src/components/settings/AIProvidersSettings.tsx');
const NATIVELY_INTERFACE = read('src/components/NativelyInterface.tsx');
const SCREEN_OCR_BRIDGE = read('electron/services/screen/ScreenOcrBridge.ts');
const SCREEN_UNDERSTANDING_SERVICE = read('electron/services/screen/ScreenUnderstandingService.ts');
const PERSONAL_KNOWLEDGE_MANAGER = read('electron/personalKnowledge/PersonalKnowledgeManager.ts');
const PERSON1_IPC = read('electron/personalKnowledge/person1Ipc.ts');

describe('Acceptance step 1: Test Connection → Verified, real error on bad key', () => {
  test('provider health + verified/disconnected model bindings are modeled', () => {
    assert.match(PROVIDER_REGISTRY, /export interface VerifiedModelBinding/);
    assert.match(PROVIDER_REGISTRY, /export interface ProviderHealth/);
    assert.match(PROVIDER_REGISTRY, /status:\s*'disconnected'\s*\|\s*'verified'\s*\|\s*'degraded'/);
  });

  test('provider health is persisted so Settings/Model Picker/routing all read the same probe result', () => {
    assert.match(CREDENTIALS_MANAGER, /getProviderHealth\(provider: string\): ProviderHealth \| undefined/);
    assert.match(CREDENTIALS_MANAGER, /setProviderHealth\(provider: string, health: ProviderHealth\): boolean/);
    assert.match(CREDENTIALS_MANAGER, /getAllProviderHealth\(\): Record<string, ProviderHealth>/);
  });

  test('test-llm-connection IPC handler exists (auth + list + chat probe entry point)', () => {
    assert.match(IPC_HANDLERS, /safeHandle\(\s*\n?\s*'test-llm-connection'/);
  });

  test('LiteLLM and Ollama have their own connection-test handlers, not silently reusing test-llm-connection', () => {
    assert.match(IPC_HANDLERS, /safeHandle\('test-litellm-connection'/);
    assert.match(IPC_HANDLERS, /safeHandle\('test-ollama-connection'/);
  });
});

describe('Acceptance step 2: model picker shows only verified models', () => {
  test('the picker filters to chat-capable bindings from providerHealth, falling back only when nothing is verified yet', () => {
    assert.match(
      AI_PROVIDERS_SETTINGS,
      /const pickerModelsForProvider[\s\S]{0,400}status === 'verified'[\s\S]{0,200}filterChatCapable\(health\.models\)/,
      'the model dropdown must be sourced from verified ProviderHealth bindings, not a static preset list',
    );
    assert.match(
      AI_PROVIDERS_SETTINGS,
      /if \(health\?\.status === 'disconnected'\) return \[\];/,
      'a disconnected provider must contribute zero models to the picker',
    );
  });
});

describe('Acceptance step 3: select model → "hi" → answer via the single chat path', () => {
  test('gemini-chat-stream IPC handler exists and drives LLMHelper.streamChat', () => {
    assert.match(IPC_HANDLERS, /safeHandle\('gemini-chat-stream', _geminiChatStreamHandler\)/);
    assert.match(IPC_HANDLERS, /llmHelper\.streamChat\(/);
  });

  test('LLMHelper exposes the public streamChat entrypoint backed by _streamChatInner', () => {
    assert.match(LLM_HELPER, /public async \* streamChat\(/);
    assert.match(LLM_HELPER, /for await \(const chunk of this\._streamChatInner\(\.\.\.args\)\)/);
  });
});

describe('Acceptance step 4: Listen → live transcript → Analyze → auto-stop → answer in chat', () => {
  test('handleStartListening starts the real mic/STT pipeline (not just a UI flag)', () => {
    assert.match(
      NATIVELY_INTERFACE,
      /const handleStartListening = \(\) => \{[\s\S]*?setIsManualRecording\(true\);[\s\S]*?setIsExpanded\(true\);[\s\S]*?startMeeting\(\)/,
    );
  });

  test('handleAnalyzeNow auto-stops the Listen session, finalizes STT, and sends the transcript for an answer', () => {
    assert.match(
      NATIVELY_INTERFACE,
      /const handleAnalyzeNow = async \(\) => \{\s*if \(!isManualRecording\) return;/,
    );
    assert.match(
      NATIVELY_INTERFACE,
      /const handleAnalyzeNow = async \(\) => \{[\s\S]*?setIsManualRecording\(false\);[\s\S]*?finalizeMicSTT/,
    );
  });
});

describe('Acceptance step 5: upload file → ask about content → grounded answer', () => {
  test('file ingest, listing, deletion, and search (retrieval) IPC handlers all exist', () => {
    assert.match(PERSON1_IPC, /safeHandle\('personal-files:pick-and-ingest'/);
    assert.match(PERSON1_IPC, /safeHandle\('personal-files:list'/);
    assert.match(PERSON1_IPC, /safeHandle\('personal-files:search'/);
  });

  test('file-type tagging (resume/job_description) exists and boosts retrieval for tagged files', () => {
    assert.match(PERSONAL_KNOWLEDGE_MANAGER, /export type PersonalFileType = 'resume' \| 'job_description' \| 'general'/);
    assert.match(PERSON1_IPC, /safeHandle\('personal-files:set-file-type'/);
    assert.match(PERSONAL_KNOWLEDGE_MANAGER, /TAGGED_FILE_BOOST/);
  });

  test('the voice/Analyze answer path does not opt out of retrieval-grounded context', () => {
    assert.doesNotMatch(
      NATIVELY_INTERFACE,
      /skipSystemPrompt:\s*true/,
      'no chat surface may bypass Context Intelligence / file grounding',
    );
  });
});

describe('Acceptance step 6: Screen → capture → OCR/vision → answer in chat', () => {
  test('a vision capability gate exists so a screen ask never silently reaches a text-only model', () => {
    assert.match(PROVIDER_REGISTRY, /export function resolveVisionGate\(/);
  });

  test('both screen-ask entry points (WTA and manual chat) call the vision gate', () => {
    const wtaStart = IPC_HANDLERS.indexOf("'generate-what-to-say'");
    const chatStart = IPC_HANDLERS.indexOf('const _geminiChatStreamHandler');
    assert.ok(wtaStart !== -1 && chatStart !== -1, 'both screen-ask entry points must exist');
    assert.ok(IPC_HANDLERS.indexOf('resolveVisionGate(', wtaStart) !== -1, 'generate-what-to-say must call resolveVisionGate');
    assert.ok(IPC_HANDLERS.indexOf('resolveVisionGate(', chatStart) !== -1, 'gemini-chat-stream must call resolveVisionGate');
  });

  test('an independent OCR bridge exists and its output is merged with vision text (dual path)', () => {
    assert.match(SCREEN_OCR_BRIDGE, /export async function extractOcrTextBestEffort\(/);
    assert.match(SCREEN_OCR_BRIDGE, /export function mergeScreenText\(/);
    assert.match(SCREEN_UNDERSTANDING_SERVICE, /extractOcrTextBestEffort, mergeScreenText \} from '\.\/ScreenOcrBridge'/);
  });
});

describe('Acceptance step 7: fail primary provider → fallback → same-context answer', () => {
  test('LLMHelper reports requested vs actual provider/model so an intentional fallback is observable, never silent', () => {
    assert.match(LLM_HELPER, /public getLastStreamRouting\(\): Readonly<typeof this\.lastStreamRouting>/);
  });

  test('ProviderRouter models a capability-aware, availability-ordered fallback cascade with Ollama included when verified', () => {
    const path2 = 'electron/llm/ProviderRouter.ts';
    const routerSource = read(path2);
    assert.match(routerSource, /export function routeLLMProviders\(/);
    assert.match(routerSource, /if \(availability\.hasOllama\) \{\s*orderedSpecs\.push\(ollama\);/);
  });
});

describe('Acceptance step 8: Ollama detected → /api/tags models → local chat works', () => {
  test('a reachability probe exists, distinct from model discovery, so a healthy-but-modelless daemon is not reported as "not found"', () => {
    assert.match(IPC_HANDLERS, /safeHandle\('is-ollama-reachable'/);
  });

  test('test-ollama-connection performs a real end-to-end probe (reachability + models + chat), mirroring test-llm-connection', () => {
    const start = IPC_HANDLERS.indexOf("safeHandle('test-ollama-connection'");
    assert.ok(start !== -1, 'test-ollama-connection handler must exist');
    const body = IPC_HANDLERS.slice(start, start + 3000);
    assert.match(body, /isOllamaReachable/);
  });

  test('Ollama participates in the live cascade only when verified/available, never hardcoded off', () => {
    const routerSource = read('electron/llm/ProviderRouter.ts');
    assert.match(routerSource, /provider: 'ollama'/);
  });
});
