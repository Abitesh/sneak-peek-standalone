import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('Single primary manual-chat path is wired through Natively Intelligence', () => {
  const ipc = read('ipcHandlers.ts');
  const engine = read('intelligence/engine/NativelyIntelligenceEngine.ts');

  assert.match(ipc, /createPrimaryManualNativelyEngine\(llmHelper, appState, requestId\)/);
  assert.match(ipc, /nativelyEngine\.prepareAndStream\(nativelyRequest\)/);
  assert.match(ipc, /Natively Intelligence\] manual-chat PRIMARY route/);
  assert.match(ipc, /llmHelper\.streamChat\(/, 'legacy stream path must remain for compatibility fallback');

  const primaryStart = ipc.indexOf('// CHANGE 13: the canonical Natively Intelligence Engine is now the PRIMARY');
  const legacyStart = ipc.indexOf('// Vision capability gate (Problem 39)', primaryStart);
  assert.ok(primaryStart >= 0 && legacyStart > primaryStart);
  const primary = ipc.slice(primaryStart, legacyStart);
  assert.doesNotMatch(primary, /buildV3Prompt\(/, 'primary route must not invoke the old V3 prompt builder');

  assert.match(engine, /TurnUnderstanding|understandTurn/);
  assert.match(engine, /planContext/);
  assert.match(engine, /retrievalCoordinator\.retrieve/);
  assert.match(engine, /buildEvidencePackFromNativelyEvidence/);
  assert.match(engine, /assembleNativelyPrompt/);
  assert.match(engine, /generationPort/);
  assert.match(engine, /pipelineStages/);
  assert.match(engine, /ProviderRouter/);
  assert.match(engine, /GenerationController/);
});

test('Primary route has exactly one generation handoff and legacy is fallback-only', () => {
  const ipc = read('ipcHandlers.ts');
  const primaryStart = ipc.indexOf('// CHANGE 13: the canonical Natively Intelligence Engine is now the PRIMARY');
  const legacyStart = ipc.indexOf('// Vision capability gate (Problem 39)', primaryStart);
  const primary = ipc.slice(primaryStart, legacyStart);
  assert.equal((primary.match(/prepareAndStream\(/g) ?? []).length, 1);
  assert.equal((primary.match(/streamFinalPrompt\(/g) ?? []).length, 0);
  assert.match(primary, /pre-commit engine failure[\s\S]*compatibility fallback/i);
});


test('Primary route does not let ordinary context or STOP fall through into a second generation', () => {
  const ipc = read('ipcHandlers.ts');
  const primaryStart = ipc.indexOf('// CHANGE 13: the canonical Natively Intelligence Engine is now the PRIMARY');
  const legacyStart = ipc.indexOf('// Vision capability gate (Problem 39)', primaryStart);
  const primary = ipc.slice(primaryStart, legacyStart);

  assert.match(primary, /!options\?\.skipSystemPrompt/);
  assert.doesNotMatch(primary, /!context\s*&&/, 'ordinary conversation context must not bypass the new engine');
  assert.match(primary, /run\.lifecycle\.state === 'CANCELLED' \|\| myController\.signal\.aborted/);
  assert.match(primary, /STOP\/supersession is terminal/);
  assert.match(primary, /return null;/);
});

test('Primary route keeps proven compatibility-only turns out of the migration', () => {
  const ipc = read('ipcHandlers.ts');
  const primaryStart = ipc.indexOf('// CHANGE 13: the canonical Natively Intelligence Engine is now the PRIMARY');
  const primary = ipc.slice(primaryStart, ipc.indexOf('const modeInfo =', primaryStart));
  assert.match(primary, /isAssistantIdentityQuestion/);
  assert.match(primary, /isStealthEvasionQuestion/);
  assert.match(primary, /nativeSkillPrefix/);
});
