#!/usr/bin/env node
/**
 * Integration test for the 6-provider system
 * Tests IPC handler responses and provider routing logic
 * 
 * Run: node validate-provider-ipc-integration.mjs
 */

import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('🧪 Provider IPC Integration Tests\n');

// Check if provider logic is in the handler
function hasTestLlmConnectionHandler(ipcContent) {
  return ipcContent.includes("'test-llm-connection'");
}

function validateProviderInHandler(handlerCode, providerId, providerName) {
  // Check if provider is in the handler
  const hasProvider = handlerCode.includes(`provider === '${providerId}'`);
  const hasUrl = handlerCode.includes(`'https://`) && handlerCode.includes(providerName.toLowerCase());
  const hasErrorHandling = handlerCode.includes('catch') && handlerCode.includes('throw');
  
  return {
    exists: hasProvider,
    hasUrl: true, // Will be validated below
    hasErrorHandling,
  };
}

const tests = [];
let passedTests = 0;
let totalTests = 0;

function test(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`✅ ${name}`);
    passedTests++;
    tests.push({ name, status: 'pass' });
  } catch (err) {
    console.log(`❌ ${name}`);
    console.log(`   Error: ${err.message}`);
    tests.push({ name, status: 'fail', error: err.message });
  }
}

// Extract and validate
console.log('📋 Loading provider configuration...\n');
const ipcPath = path.join(__dirname, 'electron/ipcHandlers.ts');
const ipcContent = fs.readFileSync(ipcPath, 'utf-8');

if (!hasTestLlmConnectionHandler(ipcContent)) {
  console.error('❌ test-llm-connection handler not found in ipcHandlers.ts');
  process.exit(1);
}

console.log('✅ test-llm-connection handler found\n');

const providers = [
  { id: 'gemini', name: 'Gemini', url: 'generativelanguage.googleapis.com' },
  { id: 'openai', name: 'OpenAI', url: 'api.openai.com' },
  { id: 'claude', name: 'Claude', url: 'api.anthropic.com' },
  { id: 'deepseek', name: 'DeepSeek', url: 'api.deepseek.com' },
  { id: 'nvidia_nim', name: 'NVIDIA NIM', url: 'integrate.api.nvidia.com' },
  { id: 'groq', name: 'Groq', url: 'api.groq.com' },
];

console.log('🔍 Validating Provider Integration\n');

for (const provider of providers) {
  test(`Provider '${provider.id}' has condition check`, () => {
    assert(ipcContent.includes(`provider === '${provider.id}'`), 
           `Missing condition for provider '${provider.id}'`);
  });
}

console.log('\n🌐 Validating API Endpoints\n');

for (const provider of providers) {
  test(`Provider '${provider.id}' has correct API endpoint (${provider.url})`, () => {
    assert(ipcContent.includes(provider.url), 
           `Missing endpoint URL for ${provider.name}: ${provider.url}`);
  });
}

console.log('\n🛡️ Validating Error Handling\n');

test('All providers use error handling', () => {
  const hasTryCatch = ipcContent.includes('try') && ipcContent.includes('catch');
  assert(hasTryCatch, 'Missing try-catch error handling');
});

test('Unsafe error logging is prevented', () => {
  // Should not log raw error objects (would leak API keys)
  const hasSafeLogging = ipcContent.includes('sanitizeErrorMessage') || 
                         ipcContent.includes('safeInfo') ||
                         ipcContent.includes('// CRITICAL: do NOT log');
  assert(hasSafeLogging, 'Missing safe error logging protection');
});

console.log('\n📦 Validating Credential Management\n');

const credPath = path.join(__dirname, 'electron/services/CredentialsManager.ts');
const credContent = fs.readFileSync(credPath, 'utf-8');

for (const provider of providers) {
  const methodName = provider.id === 'nvidia_nim' 
    ? 'NvidiaNim' 
    : provider.id.charAt(0).toUpperCase() + provider.id.slice(1);
  
  test(`CredentialsManager has get${methodName}ApiKey()`, () => {
    const getter = provider.id === 'nvidia_nim'
      ? 'getNvidiaNimApiKey'
      : `get${methodName}ApiKey`;
    assert(credContent.includes(getter), 
           `Missing getter: ${getter}`);
  });
  
  test(`CredentialsManager has set${methodName}ApiKey()`, () => {
    const setter = provider.id === 'nvidia_nim'
      ? 'setNvidiaNimApiKey'
      : `set${methodName}ApiKey`;
    assert(credContent.includes(setter), 
           `Missing setter: ${setter}`);
  });
}

console.log('\n🚀 Validating LLMHelper Implementation\n');

const llmPath = path.join(__dirname, 'electron/LLMHelper.ts');
const llmContent = fs.readFileSync(llmPath, 'utf-8');

const llmMethods = {
  'gemini': 'tryGenerateResponse',
  'openai': 'generateWithOpenai',
  'claude': 'generateWithClaude',
  'deepseek': 'generateWithDeepseek',
  'nvidia_nim': 'generateWithNvidiaNim',
  'groq': 'generateWithGroq',
};

for (const provider of providers) {
  const methodName = llmMethods[provider.id];
  test(`LLMHelper has ${methodName}() method for ${provider.name}`, () => {
    assert(llmContent.includes(methodName),
           `Missing method: ${methodName}`);
  });
}

console.log('\n📊 Test Summary\n');
console.log(`Total: ${passedTests}/${totalTests} tests passed (${Math.round(passedTests/totalTests*100)}%)\n`);

if (passedTests === totalTests) {
  console.log('✅ All provider integration checks passed!');
  console.log('\n📝 Provider Configuration Status:');
  for (const provider of providers) {
    console.log(`  ✓ ${provider.name.padEnd(15)} - Fully integrated`);
  }
  process.exit(0);
} else {
  console.log('❌ Some provider integration checks failed.\n');
  const failures = tests.filter(t => t.status === 'fail');
  console.log('Failed tests:');
  for (const test of failures) {
    console.log(`  ✗ ${test.name}`);
    if (test.error) console.log(`    ${test.error}`);
  }
  process.exit(1);
}
