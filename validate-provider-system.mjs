#!/usr/bin/env node
/**
 * Validation script for the 6-provider system
 * Checks that all required provider infrastructure is in place
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('🔍 Validating 6-Provider System Architecture\n');

const PROVIDERS = [
  { name: 'Gemini', id: 'gemini', ipcKeyPattern: /setGeminiApiKey|getGeminiApiKey|gemini.*provider/ },
  { name: 'OpenAI', id: 'openai', ipcKeyPattern: /setOpenaiApiKey|getOpenaiApiKey|openai.*provider/ },
  { name: 'Claude', id: 'claude', ipcKeyPattern: /setClaudeApiKey|getClaudeApiKey|claude.*provider/ },
  { name: 'DeepSeek', id: 'deepseek', ipcKeyPattern: /setDeepseekApiKey|getDeepseekApiKey|deepseek.*provider/ },
  { name: 'NVIDIA NIM', id: 'nvidia_nim', ipcKeyPattern: /setNvidiaNimApiKey|getNvidiaNimApiKey|nvidia_nim.*provider/ },
  { name: 'Groq', id: 'groq', ipcKeyPattern: /setGroqApiKey|getGroqApiKey|groq.*provider/ },
];

const checks = [];

// Check 1: CredentialsManager has all providers
console.log('1️⃣  Checking CredentialsManager.ts...');
const credManagerPath = path.join(__dirname, 'electron/services/CredentialsManager.ts');
const credManagerContent = fs.readFileSync(credManagerPath, 'utf-8');

const getterSetterPatterns = {
  'Gemini': ['getGeminiApiKey', 'setGeminiApiKey'],
  'OpenAI': ['getOpenaiApiKey', 'setOpenaiApiKey'],
  'Claude': ['getClaudeApiKey', 'setClaudeApiKey'],
  'DeepSeek': ['getDeepseekApiKey', 'setDeepseekApiKey'],
  'NVIDIA NIM': ['getNvidiaNimApiKey', 'setNvidiaNimApiKey'],
  'Groq': ['getGroqApiKey', 'setGroqApiKey'],
};

for (const provider of PROVIDERS) {
  const patterns = getterSetterPatterns[provider.name];
  const hasGetter = patterns[0] && credManagerContent.includes(patterns[0]);
  const hasSetter = patterns[1] && credManagerContent.includes(patterns[1]);
  
  const status = hasGetter && hasSetter ? '✅' : '❌';
  console.log(`   ${status} ${provider.name}: get/set methods`);
  checks.push({ provider: provider.name, credManager: hasGetter && hasSetter });
}

// Check 2: IPC handlers support all providers
console.log('\n2️⃣  Checking IPC handlers (ipcHandlers.ts)...');
const ipcHandlersPath = path.join(__dirname, 'electron/ipcHandlers.ts');
const ipcContent = fs.readFileSync(ipcHandlersPath, 'utf-8');

const hasTestLlmConnection = ipcContent.includes("'test-llm-connection'");
console.log(`   ${hasTestLlmConnection ? '✅' : '❌'} test-llm-connection handler exists`);

// Extract provider cases from test-llm-connection
const testLlmSection = ipcContent.match(/'test-llm-connection'[\s\S]*?(?=safeHandle\()/)?.[0] || '';

for (const provider of PROVIDERS) {
  const hasProvider = testLlmSection.includes(`provider === '${provider.id}'`) || 
                      testLlmSection.includes(`'${provider.id}'`);
  const status = hasProvider ? '✅' : '❌';
  console.log(`   ${status} ${provider.name} (${provider.id}): connection test`);
  checks.push({ provider: provider.name, ipcTest: hasProvider });
}

// Check 3: LLMHelper supports all providers
console.log('\n3️⃣  Checking LLMHelper.ts provider methods...');
const llmHelperPath = path.join(__dirname, 'electron/LLMHelper.ts');
const llmContent = fs.readFileSync(llmHelperPath, 'utf-8');

const providerMethods = {
  gemini: /generateWithGemini|tryGenerateResponse.*gemini/,
  openai: /generateWithOpenai/,
  claude: /generateWithClaude/,
  deepseek: /generateWithDeepseek/,
  nvidia_nim: /nvidiaNimClient|nvidia_nim/,
  groq: /generateWithGroq|GROQ.*TEXT/,
};

for (const provider of PROVIDERS) {
  const methodPattern = providerMethods[provider.id];
  const hasMethod = methodPattern.test(llmContent);
  const status = hasMethod ? '✅' : '❌';
  console.log(`   ${status} ${provider.name}: implementation`);
  checks.push({ provider: provider.name, llmHelper: hasMethod });
}

// Check 4: TypeScript compilation
console.log('\n4️⃣  Checking TypeScript compilation status...');
const tsconfigPath = path.join(__dirname, 'tsconfig.json');
const electronTsconfigPath = path.join(__dirname, 'electron/tsconfig.json');

const hasMainTsconfig = fs.existsSync(tsconfigPath);
const hasElectronTsconfig = fs.existsSync(electronTsconfigPath);

console.log(`   ${hasMainTsconfig ? '✅' : '❌'} Main tsconfig.json exists`);
console.log(`   ${hasElectronTsconfig ? '✅' : '❌'} Electron tsconfig.json exists`);

// Check 5: Build artifacts
console.log('\n5️⃣  Checking build artifacts...');
const distElectronPath = path.join(__dirname, 'dist-electron/electron/main.js');
const distMainPath = path.join(__dirname, 'dist/index.js');

const hasElectronBuild = fs.existsSync(distElectronPath);
const hasMainBuild = fs.existsSync(distMainPath);

console.log(`   ${hasElectronBuild ? '✅' : '❌'} dist-electron/electron/main.js exists`);
console.log(`   ${hasMainBuild ? '✅' : '❌'} dist/index.js exists`);

// Summary
console.log('\n📊 Summary:\n');
const allProviders = [...new Set(checks.map(c => c.provider))];
const provider2Checks = {};

allProviders.forEach(p => {
  const providerChecks = checks.filter(c => c.provider === p);
  const score = Object.values(providerChecks[0] || {}).filter(v => v === true).length;
  provider2Checks[p] = { score, total: Object.keys(providerChecks[0] || {}).length - 1 };
});

for (const provider of PROVIDERS) {
  const result = provider2Checks[provider.name];
  const symbol = result.score === result.total ? '✅' : '⚠️';
  console.log(`${symbol} ${provider.name}: ${result.score}/${result.total} checks passed`);
}

// Overall result
const totalPassed = Object.values(provider2Checks).reduce((a, b) => a + b.score, 0);
const totalChecks = Object.values(provider2Checks).reduce((a, b) => a + b.total, 0);

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`Overall: ${totalPassed}/${totalChecks} checks passed (${Math.round(totalPassed/totalChecks*100)}%)\n`);

if (totalPassed === totalChecks) {
  console.log('✅ All provider systems are properly configured!');
  process.exit(0);
} else {
  console.log('⚠️  Some provider systems need attention.');
  process.exit(1);
}
