#!/usr/bin/env node

/**
 * Test Model Discovery Flow Integration
 * 
 * This script verifies that:
 * 1. fetchProviderModels IPC handler is defined in electron/ipcHandlers.ts
 * 2. modelFetcher.ts is complete with all 6 providers
 * 3. Preload.ts exposes fetchProviderModels API
 * 4. ProviderCard calls the IPC method correctly
 * 5. AIProvidersSettings reloads cloudFetchedModels after discovery
 */

import fs from 'fs';
import path from 'path';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const projectRoot = __dirname;

function readFile(filePath) {
    return fs.readFileSync(path.join(projectRoot, filePath), 'utf-8');
}

function checkFileContains(filePath, patterns, description) {
    const content = readFile(filePath);
    const results = {
        file: filePath,
        description,
        checks: []
    };
    
    for (const [pattern, label] of patterns) {
        const regex = typeof pattern === 'string' ? new RegExp(pattern, 'g') : pattern;
        const found = regex.test(content);
        results.checks.push({
            label,
            found,
            status: found ? '✓' : '✗'
        });
    }
    
    return results;
}

console.log('🔍 Testing Model Discovery Flow Integration\n');

const tests = [
    // Test 1: modelFetcher.ts has all 6 providers
    checkFileContains(
        'electron/utils/modelFetcher.ts',
        [
            ['export async function fetchProviderModels', 'fetchProviderModels main entry point'],
            ['fetchOpenAIModels', 'OpenAI provider'],
            ['fetchAnthropicModels', 'Anthropic/Claude provider'],
            ['fetchGeminiModels', 'Gemini provider'],
            ['fetchGroqModels', 'Groq provider'],
            ['fetchDeepSeekModels', 'DeepSeek provider'],
            ['fetchNvidiaNimModels', 'NVIDIA NIM provider']
        ],
        'Model Fetcher - All Providers'
    ),
    
    // Test 2: ipcHandlers.ts has fetch-provider-models handler
    checkFileContains(
        'electron/ipcHandlers.ts',
        [
            ["'fetch-provider-models'", "fetch-provider-models IPC handler"],
            ['fetchProviderModels\\(provider', 'Calls fetchProviderModels'],
            ['setCloudFetchedModels', 'Persists models via CredentialsManager']
        ],
        'IPC Handlers - Model Discovery'
    ),
    
    // Test 3: Preload exposes fetchProviderModels
    checkFileContains(
        'electron/preload.ts',
        [
            ['fetchProviderModels.*ipcRenderer.invoke.*fetch-provider-models', 'Exposes fetchProviderModels API'],
            ["provider: 'gemini' \\| 'groq' \\| 'openai' \\| 'claude' \\| 'deepseek' \\| 'nvidia_nim'", 'Supports all 6 providers']
        ],
        'Preload - API Exposure'
    ),
    
    // Test 4: electron.d.ts defines the type
    checkFileContains(
        'src/types/electron.d.ts',
        [
            ['fetchProviderModels.*Promise.*success.*models', 'Type definition for fetchProviderModels']
        ],
        'Type Definitions - electron.d.ts'
    ),
    
    // Test 5: ProviderCard calls fetchProviderModels
    checkFileContains(
        'src/components/settings/ProviderCard.tsx',
        [
            ['window.electronAPI\\?.fetchProviderModels', 'Calls fetchProviderModels IPC'],
            ['onModelsRefreshed', 'Has onModelsRefreshed callback prop'],
            ['handleFetchModels', 'Has handleFetchModels function'],
            ['onFirstOpen.*handleFetchModels', 'Calls on first open of models list']
        ],
        'ProviderCard - Model Discovery'
    ),
    
    // Test 6: AIProvidersSettings passes callback
    checkFileContains(
        'src/components/settings/AIProvidersSettings.tsx',
        [
            ['handleReloadCloudModels', 'Has handleReloadCloudModels handler'],
            ['getCloudFetchedModels', 'Reloads cloudFetchedModels from IPC'],
            ['onModelsRefreshed=\\{handleReloadCloudModels\\}', 'Passes callback to ProviderCard']
        ],
        'AIProvidersSettings - Model Reload'
    ),
    
    // Test 7: CredentialsManager persists models
    checkFileContains(
        'electron/services/CredentialsManager.ts',
        [
            ['setCloudFetchedModels', 'Has setCloudFetchedModels method'],
            ['getAllCloudFetchedModels', 'Has getAllCloudFetchedModels method'],
            ['getCloudFetchedAt', 'Tracks fetch timestamps']
        ],
        'CredentialsManager - Model Persistence'
    )
];

// Display results
let passCount = 0;
let failCount = 0;

tests.forEach(test => {
    console.log(`📄 ${test.description}`);
    console.log(`   File: ${test.file}`);
    
    test.checks.forEach(check => {
        console.log(`   ${check.status} ${check.label}`);
        if (check.found) passCount++;
        else failCount++;
    });
    console.log();
});

// Summary
console.log('═'.repeat(60));
console.log(`✅ PASSED: ${passCount}`);
console.log(`❌ FAILED: ${failCount}`);
console.log(`📊 TOTAL:  ${passCount + failCount}`);

if (failCount === 0) {
    console.log('\n🎉 All model discovery integration checks passed!');
    process.exit(0);
} else {
    console.log(`\n⚠️  ${failCount} check(s) failed. Review implementation.`);
    process.exit(1);
}
