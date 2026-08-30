// electron/services/__tests__/ScreenPipeline2026_08_31.test.mjs
//
// Sprint S7 — Screen / OCR / Vision pipeline (Problems 36-40, 45).
//
// Covers:
//  - resolveVisionGate (providerRegistry.ts): a screen ask must never reach a
//    text-only model — auto-switch to a verified vision-capable binding, or
//    refuse with a clear message (Problem 39).
//  - mergeScreenText / buildScreenLayer: OCR text merges into the same
//    context text a vision model's extraction occupies, even when vision
//    succeeded (Problem 40 — dual path for accuracy).
//  - Static wiring: both screen-ask entry points (generate-what-to-say,
//    gemini-chat-stream) call the gate before any images reach a provider,
//    and ScreenUnderstandingService races OCR alongside vision rather than
//    serially or not at all.
//
// Run: npm run build:electron, then node --test on this file (or `npm test`).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const distImport = (rel) => import(pathToFileURL(path.resolve(root, 'dist-electron', rel)).href);

const { resolveVisionGate, filterVisionCapable, bindingFromModelId } =
  await distImport('electron/llm/providerRegistry.js');
const { buildScreenLayer } = await distImport('electron/llm/contextEngine.js');
const { mergeScreenText } = await distImport('electron/services/screen/ScreenOcrBridge.js');

describe('resolveVisionGate (Problem 39 — vision capability gating)', () => {
  test('a model that already supports images is allowed through untouched', () => {
    const gate = resolveVisionGate({ supportsImages: true }, {});
    assert.deepEqual(gate, { ok: true });
  });

  test('a text-only model auto-switches to a verified vision-capable binding when one exists', () => {
    const visionBinding = bindingFromModelId('gpt-4o', 'openai', { visionOk: true });
    const health = {
      openai: { status: 'verified', authOk: true, lastProbeAt: Date.now(), models: [visionBinding] },
      groq: {
        status: 'verified', authOk: true, lastProbeAt: Date.now(),
        models: [bindingFromModelId('llama-3.1-8b-instant', 'groq', { visionOk: false })],
      },
    };
    const gate = resolveVisionGate({ supportsImages: false }, health);
    assert.equal(gate.ok, true);
    assert.equal(gate.switchTo?.id, 'gpt-4o');
  });

  test('a text-only model with zero verified vision bindings anywhere is blocked with a clear message', () => {
    const health = {
      groq: {
        status: 'verified', authOk: true, lastProbeAt: Date.now(),
        models: [bindingFromModelId('llama-3.1-8b-instant', 'groq', { visionOk: false })],
      },
    };
    const gate = resolveVisionGate({ supportsImages: false }, health);
    assert.equal(gate.ok, false);
    assert.equal(gate.switchTo, undefined);
    assert.match(gate.message, /vision-capable/i);
  });

  test('a non-chat-capable vision binding (probe failed) is never offered as the auto-switch target', () => {
    const nonChatVision = bindingFromModelId('some-vision-model', 'custom', { visionOk: true, chatOk: false });
    const health = { custom: { status: 'degraded', authOk: true, lastProbeAt: Date.now(), models: [nonChatVision] } };
    const gate = resolveVisionGate({ supportsImages: false }, health);
    assert.equal(gate.ok, false);
  });

  test('null-safe against a missing/empty provider health map', () => {
    assert.equal(resolveVisionGate({ supportsImages: false }, {}).ok, false);
    assert.equal(resolveVisionGate({ supportsImages: false }, undefined).ok, false);
  });
});

describe('buildScreenLayer (Context Engine screen layer)', () => {
  test('non-empty text becomes a screen layer with the given priority', () => {
    const layer = buildScreenLayer('Two Sum: given an array...', 3);
    assert.deepEqual(layer, { id: 'screen', text: 'Two Sum: given an array...', priority: 3 });
  });

  test('empty/whitespace-only text yields no layer (never blind-inserted)', () => {
    assert.equal(buildScreenLayer(''), null);
    assert.equal(buildScreenLayer('   \n  '), null);
    assert.equal(buildScreenLayer(undefined), null);
    assert.equal(buildScreenLayer(null), null);
  });
});

describe('mergeScreenText (Problem 40 — OCR text merges alongside vision text)', () => {
  test('OCR text is appended after vision text when the two differ', () => {
    const merged = mergeScreenText('A slide about quarterly revenue.', 'Q3 Revenue: $4.2M\nQ4 Revenue: $5.1M');
    assert.match(merged, /A slide about quarterly revenue\./);
    assert.match(merged, /Q3 Revenue: \$4\.2M/);
    assert.match(merged, /\[OCR-extracted text\]/);
  });

  test('a near-duplicate OCR pass is deduped, not appended twice', () => {
    const merged = mergeScreenText('Two Sum problem statement', 'two   sum problem statement');
    assert.equal(merged, 'Two Sum problem statement');
  });

  test('vision failure still surfaces recovered OCR text (vision OR OCR, never neither)', () => {
    assert.equal(mergeScreenText(undefined, 'raw ocr text'), 'raw ocr text');
    assert.equal(mergeScreenText('', 'raw ocr text'), 'raw ocr text');
  });

  test('OCR failure still surfaces the vision text (dual path degrades gracefully)', () => {
    assert.equal(mergeScreenText('vision summary', ''), 'vision summary');
    assert.equal(mergeScreenText('vision summary', undefined), 'vision summary');
  });
});

describe('End-to-end wiring: screen button -> capture -> vision/OCR -> gate -> chat', () => {
  test('generate-what-to-say (Answer/WTA surface) resolves the vision gate before touching ScreenUnderstandingService', () => {
    const source = read('electron/ipcHandlers.ts');
    const wtaStart = source.indexOf("'generate-what-to-say'");
    assert.ok(wtaStart !== -1, 'generate-what-to-say handler must exist');
    const gateCall = source.indexOf('resolveVisionGate(', wtaStart);
    const susCall = source.indexOf('getScreenUnderstandingService', wtaStart);
    assert.ok(gateCall !== -1, 'WTA handler must call resolveVisionGate');
    assert.ok(susCall !== -1, 'WTA handler must still route through ScreenUnderstandingService');
    assert.ok(gateCall < susCall, 'the vision gate must run BEFORE ScreenUnderstandingService, not after');
  });

  test('gemini-chat-stream (manual chat surface) resolves the vision gate before the V3/legacy prompt assembly', () => {
    const source = read('electron/ipcHandlers.ts');
    const handlerStart = source.indexOf('const _geminiChatStreamHandler');
    assert.ok(handlerStart !== -1, 'gemini-chat-stream handler must exist');
    const gateCall = source.indexOf('resolveVisionGate(', handlerStart);
    const v3Call = source.indexOf("surface: 'manual-chat'", handlerStart);
    assert.ok(gateCall !== -1, 'manual-chat handler must call resolveVisionGate');
    assert.ok(gateCall < v3Call, 'the vision gate must run before prompt assembly picks a routing branch');
  });

  test('both screen-ask surfaces auto-switch via llmHelper.setModel when the gate finds a vision binding, never silently', () => {
    const source = read('electron/ipcHandlers.ts');
    const occurrences = source.split('gate.switchTo').length - 1;
    assert.ok(occurrences >= 2, 'both surfaces must branch on gate.switchTo');
    assert.match(source, /console\.warn\(\s*\n?\s*`\[VisionGate\]/, 'an auto-switch must be logged, not silent');
  });

  test('ScreenUnderstandingService races OCR alongside vision (Problem 40), not serially and not never', () => {
    const source = read('electron/services/screen/ScreenUnderstandingService.ts');
    assert.match(source, /import \{ extractOcrTextBestEffort, mergeScreenText \} from '\.\/ScreenOcrBridge'/);
    assert.match(source, /Promise\.all\(\[\s*\n\s*runVisionFallback\(\{/, 'vision and OCR must run in the same Promise.all, not one after the other');
    assert.match(source, /extractOcrTextBestEffort\(latestPath\)/);
  });

  test('the merged extractedText (not raw vision-only text) is what ships in the successful result', () => {
    const source = read('electron/services/screen/ScreenUnderstandingService.ts');
    assert.match(source, /mergeScreenText\(visionExtractedText, ctx\.ocrText\)/);
  });

  test('OCR-only recovery on vision failure ships extractedText/ocrText instead of leaving both undefined', () => {
    const source = read('electron/services/screen/ScreenUnderstandingService.ts');
    const failBranchStart = source.indexOf('if (!fallback.ok)');
    const failBranchEnd = source.indexOf('const structured = this.extractStructured', failBranchStart);
    const block = source.slice(failBranchStart, failBranchEnd);
    assert.match(block, /ocrFallbackLayer = buildScreenLayer\(ctx\.ocrText\)/);
    assert.match(block, /extractedText: ocrFallbackLayer\?\.text/);
  });

  test('Screen button capture still flows through ScreenshotHelper (unchanged capture path)', () => {
    const source = read('src/components/NativelyInterface.tsx');
    assert.match(source, /takeScreenshot: async \(\) => \{[\s\S]{0,200}window\.electronAPI\.takeScreenshot\(\)/,
      'the Screen button must still capture via the existing takeScreenshot IPC (ScreenshotHelper-backed)');
  });

  test('the answer still renders in the normal chat surface, not an isolated window', () => {
    const source = read('src/components/NativelyInterface.tsx');
    // handleWhatToSay (the Answer path a Screen capture feeds into) mounts its
    // streaming placeholder into the same `messages` state the rest of chat
    // uses — there is no separate BrowserWindow/portal for screen answers.
    assert.match(source, /prepareIntelligenceStreamPlaceholder\('what_to_answer'\)/);
  });
});
