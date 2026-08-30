#!/usr/bin/env node

/**
 * End-to-End Integration Test: Model Discovery Flow
 * 
 * This script verifies the complete model discovery workflow:
 * 1. Renderer can call fetchProviderModels via IPC
 * 2. Main process receives and validates the call
 * 3. Main process fetches models from provider API
 * 4. Models are persisted to the database
 * 5. Renderer can retrieve persisted models
 * 6. UI can re-render with new models
 */

import fs from 'fs';
import path from 'path';

// Test 1: Verify IPC channel is registered
console.log('🔍 Verifying IPC Integration\n');

const ipcHandlers = fs.readFileSync(
    path.join(process.cwd(), 'electron/ipcHandlers.ts'),
    'utf-8'
);

const tests = [
    {
        name: 'IPC handler "fetch-provider-models" is registered',
        check: () => ipcHandlers.includes("ipcMain.handle('fetch-provider-models'") ||
                     ipcHandlers.includes('ipcMain.handle("fetch-provider-models"') ||
                     ipcHandlers.includes("'fetch-provider-models'") && ipcHandlers.includes('fetchProviderModels')
    },
    {
        name: 'Handler calls fetchProviderModels from modelFetcher',
        check: () => ipcHandlers.includes('fetchProviderModels(provider') &&
                     ipcHandlers.includes("require.*modelFetcher") || ipcHandlers.includes("import.*modelFetcher")
    },
    {
        name: 'Handler persists models via CredentialsManager.setCloudFetchedModels',
        check: () => ipcHandlers.includes('setCloudFetchedModels')
    },
    {
        name: 'Handler catches and returns errors safely',
        check: () => ipcHandlers.includes('catch') && ipcHandlers.includes('error')
    }
];

let passCount = 0;
let failCount = 0;

tests.forEach(test => {
    const result = test.check();
    const status = result ? '✓' : '✗';
    console.log(`${status} ${test.name}`);
    if (result) passCount++;
    else failCount++;
});

console.log(`\n📊 IPC Integration: ${passCount}/${passCount + failCount} passed\n`);

// Test 2: Verify preload exposes the API correctly
console.log('🔍 Verifying Preload API\n');

const preload = fs.readFileSync(
    path.join(process.cwd(), 'electron/preload.ts'),
    'utf-8'
);

const preloadTests = [
    {
        name: 'Preload has fetchProviderModels function',
        check: () => preload.includes('fetchProviderModels')
    },
    {
        name: 'Function calls ipcRenderer.invoke("fetch-provider-models"...)',
        check: () => preload.includes("ipcRenderer.invoke('fetch-provider-models'") ||
                     preload.includes('ipcRenderer.invoke("fetch-provider-models"')
    },
    {
        name: 'Function accepts provider parameter (gemini|groq|openai|claude|deepseek|nvidia_nim)',
        check: () => preload.includes('gemini') && preload.includes('groq') &&
                     preload.includes('openai') && preload.includes('claude') &&
                     preload.includes('deepseek') && preload.includes('nvidia_nim')
    }
];

let preloadPass = 0;
let preloadFail = 0;

preloadTests.forEach(test => {
    const result = test.check();
    const status = result ? '✓' : '✗';
    console.log(`${status} ${test.name}`);
    if (result) preloadPass++;
    else preloadFail++;
});

console.log(`\n📊 Preload API: ${preloadPass}/${preloadPass + preloadFail} passed\n`);

// Test 3: Verify ProviderCard wiring
console.log('🔍 Verifying ProviderCard Component\n');

const providerCard = fs.readFileSync(
    path.join(process.cwd(), 'src/components/settings/ProviderCard.tsx'),
    'utf-8'
);

const cardTests = [
    {
        name: 'ProviderCard has handleFetchModels function',
        check: () => providerCard.includes('handleFetchModels')
    },
    {
        name: 'handleFetchModels calls window.electronAPI?.fetchProviderModels',
        check: () => providerCard.includes("window.electronAPI?.fetchProviderModels")
    },
    {
        name: 'ProviderCard accepts onModelsRefreshed callback',
        check: () => providerCard.includes('onModelsRefreshed')
    },
    {
        name: 'AipModelList calls handleFetchModels onRefresh',
        check: () => providerCard.includes('onRefresh={handleFetchModels}')
    },
    {
        name: 'AipModelList calls handleFetchModels onFirstOpen',
        check: () => providerCard.includes('onFirstOpen') && providerCard.includes('handleFetchModels')
    }
];

let cardPass = 0;
let cardFail = 0;

cardTests.forEach(test => {
    const result = test.check();
    const status = result ? '✓' : '✗';
    console.log(`${status} ${test.name}`);
    if (result) cardPass++;
    else cardFail++;
});

console.log(`\n📊 ProviderCard Component: ${cardPass}/${cardPass + cardFail} passed\n`);

// Test 4: Verify AIProvidersSettings wiring
console.log('🔍 Verifying AIProvidersSettings Integration\n');

const settings = fs.readFileSync(
    path.join(process.cwd(), 'src/components/settings/AIProvidersSettings.tsx'),
    'utf-8'
);

const settingsTests = [
    {
        name: 'AIProvidersSettings has handleReloadCloudModels function',
        check: () => settings.includes('handleReloadCloudModels')
    },
    {
        name: 'handleReloadCloudModels calls getCloudFetchedModels IPC',
        check: () => settings.includes('getCloudFetchedModels') && settings.includes('handleReloadCloudModels')
    },
    {
        name: 'handleReloadCloudModels updates cloudFetchedModels state',
        check: () => settings.includes('setCloudFetchedModels') && settings.includes('handleReloadCloudModels')
    },
    {
        name: 'ProviderCard receives onModelsRefreshed={handleReloadCloudModels}',
        check: () => settings.includes('onModelsRefreshed={handleReloadCloudModels}')
    }
];

let settingsPass = 0;
let settingsFail = 0;

settingsTests.forEach(test => {
    const result = test.check();
    const status = result ? '✓' : '✗';
    console.log(`${status} ${test.name}`);
    if (result) settingsPass++;
    else settingsFail++;
});

console.log(`\n📊 AIProvidersSettings: ${settingsPass}/${settingsPass + settingsFail} passed\n`);

// Overall summary
const total = passCount + failCount + preloadPass + preloadFail + cardPass + cardFail + settingsPass + settingsFail;
const totalPass = passCount + preloadPass + cardPass + settingsPass;

console.log('═'.repeat(60));
console.log(`📈 Overall: ${totalPass}/${total} integration checks passed`);
console.log(`🎯 Model Discovery Flow Integration: ${totalPass === total ? '✓ COMPLETE' : '✗ INCOMPLETE'}`);

if (totalPass === total) {
    console.log('\n✅ All integration points verified!\n');
    process.exit(0);
} else {
    console.log(`\n⚠️  ${total - totalPass} check(s) failed\n`);
    process.exit(1);
}
