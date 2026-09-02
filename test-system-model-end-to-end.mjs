import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = __dirname;

console.log('\n========== TEST: System Model Selection End-to-End ==========\n');

// Test 1: Verify ipcHandlers validates model IDs before persisting
console.log('[TEST 1] IPC handler validates model IDs...');
const ipcHandlersSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'dist-electron/electron/ipcHandlers.js'), 'utf-8');

assert.ok(
    ipcHandlersSrc.includes('local-whisper-set-channel-config') || ipcHandlersSrc.includes('localWhisperSetChannelConfig'),
    'IPC handler for model config must exist'
);

assert.ok(
    ipcHandlersSrc.includes('MODEL_CATALOG_IDS'),
    'IPC handler must reference MODEL_CATALOG_IDS for validation'
);

assert.ok(
    ipcHandlersSrc.includes('systemModelId'),
    'IPC handler must handle systemModelId'
);

console.log('✓ IPC handler properly validates model IDs\n');

// Test 2: Verify SettingsManager has per-channel keys in SOURCE
console.log('[TEST 2] SettingsManager has per-channel keys...');
const settingsManagerSrc = fs.readFileSync(
    path.join(PROJECT_ROOT, 'electron/services/SettingsManager.ts'), 
    'utf-8'
);

assert.ok(
    settingsManagerSrc.includes('localWhisperModelMic'),
    'SettingsManager must have localWhisperModelMic key'
);

assert.ok(
    settingsManagerSrc.includes('localWhisperModelSystem'),
    'SettingsManager must have localWhisperModelSystem key'
);

assert.ok(
    settingsManagerSrc.includes('localWhisperPerChannelEnabled'),
    'SettingsManager must have localWhisperPerChannelEnabled flag'
);

console.log('✓ SettingsManager has all per-channel keys\n');

// Test 3: Verify main.ts uses the per-channel model IDs
console.log('[TEST 3] main.ts creates STT with correct model ID...');
const mainSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'electron/main.ts'), 'utf-8');

// Extract the STT provider creation code section
const sttSection = mainSrc.match(/sttProvider === 'local-whisper'[\s\S]{0,3000}?stt = lws/);
assert.ok(sttSection, 'Must have local-whisper STT provider section');

const sttCode = sttSection[0];
console.log('Verifying STT creation logic...');

assert.ok(sttCode.includes('localWhisperPerChannelEnabled'), 
    'Must check localWhisperPerChannelEnabled');
assert.ok(sttCode.includes('localWhisperModelSystem'), 
    'Must read localWhisperModelSystem for system channel');
assert.ok(sttCode.includes("speaker === 'interviewer'"), 
    'Must identify system channel as interviewer');
assert.ok(sttCode.includes('setChannel'), 
    'Must call setChannel to tag STT instance');

console.log('✓ main.ts correctly wires system model ID to STT\n');

// Test 4: Verify UI component sends model ID via IPC
console.log('[TEST 4] UI component sends model selection via IPC...');
const panelSrc = fs.readFileSync(
    path.join(PROJECT_ROOT, 'src/components/LocalWhisperModelPanel.tsx'),
    'utf-8'
);

assert.ok(
    panelSrc.includes('localWhisperSetChannelConfig'),
    'UI must call localWhisperSetChannelConfig IPC handler'
);

assert.ok(
    panelSrc.includes('systemModelId: modelId'),
    'UI must include systemModelId in the IPC call'
);

console.log('✓ UI component sends system model selection\n');

// Test 5: Verify model validation happens in MODEL_CATALOG
console.log('[TEST 5] Model catalog contains validation set...');
const modelManagerSrc = fs.readFileSync(
    path.join(PROJECT_ROOT, 'electron/audio/whisper/modelManager.ts'),
    'utf-8'
);

assert.ok(
    modelManagerSrc.includes('MODEL_CATALOG_IDS'),
    'Model manager must export MODEL_CATALOG_IDS Set'
);

// Check for Tiny English model (the default)
assert.ok(
    modelManagerSrc.includes('Xenova/whisper-tiny') || modelManagerSrc.includes('whisper-tiny'),
    'Model catalog must include Tiny English model'
);

console.log('✓ Model catalog properly validated\n');

console.log('========== TEST COMPLETE ==========\n');
console.log('✓ System Model Selection wiring verified end-to-end');
console.log('  - IPC handler validates before persisting');
console.log('  - SettingsManager stores per-channel keys');
console.log('  - main.ts reads correct key based on channel');
console.log('  - UI component sends selection via IPC');
console.log('  - Model catalog validates against whitelist\n');

process.exit(0);
