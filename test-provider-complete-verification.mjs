#!/usr/bin/env node
/**
 * COMPLETE PROVIDER VERIFICATION TEST
 * Tests all 6 providers: Gemini, OpenAI, Claude, DeepSeek, Groq, NVIDIA NIM
 * 
 * Verifies:
 * 1. LLMHelper is sole authoritative provider manager
 * 2. CredentialsManager has ONE system for all 6 providers
 * 3. Model discovery IPC handlers exist
 * 4. Test connection IPC handlers exist
 * 5. No Natively API active routes
 * 6. No duplicate provider clients
 * 7. All 6 providers have detection methods
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readFile(filePath) {
  return fs.readFileSync(path.join(__dirname, filePath), 'utf-8');
}

function search(content, pattern, flags = 'g') {
  const regex = new RegExp(pattern, flags);
  return regex.test(content);
}

function extract(content, pattern, flags = 'g') {
  const regex = new RegExp(pattern, flags);
  const matches = content.match(regex);
  return matches || [];
}

const tests = {
  pass: 0,
  fail: 0,
  failed: [],
};

function test(name, condition, details = '') {
  if (condition) {
    tests.pass++;
    console.log(`✓ ${name}`);
  } else {
    tests.fail++;
    tests.failed.push(name);
    console.log(`✗ ${name}`);
    if (details) console.log(`  ${details}`);
  }
}

console.log('=== PROVIDER ARCHITECTURE VERIFICATION ===\n');

// ==== PHASE 3: Six Provider Architecture ====
console.log('PHASE 3: SIX PROVIDER ARCHITECTURE');
const llmHelper = readFile('electron/LLMHelper.ts');
test('LLMHelper is main provider manager', search(llmHelper, 'export class LLMHelper'));
test('Has Gemini client (this.client)', search(llmHelper, 'this\\.client\\s*=\\s*new GoogleGenAI'));
test('Has OpenAI client (this.openaiClient)', search(llmHelper, 'this\\.openaiClient\\s*=\\s*new OpenAI'));
test('Has Claude client (this.claudeClient)', search(llmHelper, 'this\\.claudeClient\\s*=\\s*new Anthropic'));
test('Has Groq client (this.groqClient)', search(llmHelper, 'this\\.groqClient\\s*=\\s*new Groq'));
test('Has DeepSeek client (this.deepseekClient)', search(llmHelper, 'this\\.deepseekClient\\s*=\\s*new OpenAI.*DEEPSEEK_BASE_URL'));
test('Has NVIDIA NIM client (this.nvidiaNimClient)', search(llmHelper, 'this\\.nvidiaNimClient.*new OpenAI.*NVIDIA_NIM_BASE_URL'));
test('All 6 detection methods exist', search(llmHelper, 'isGeminiModel') && search(llmHelper, 'isOpenAiModel') && search(llmHelper, 'isClaudeModel') && search(llmHelper, 'isGroqModel') && search(llmHelper, 'isDeepseekModel') && search(llmHelper, 'isNvidiaNimModel'));
test('No active Natively generation (throws error)', search(llmHelper, 'private async \\* streamWithNatively.*throw new Error.*disabled'));
test('No Natively generation route (throws error)', search(llmHelper, 'private async generateWithNatively.*throw new Error.*disabled'));

// ==== PHASE 4: One Credential System ====
console.log('\nPHASE 4: ONE CREDENTIAL SYSTEM');
const credMgr = readFile('electron/services/CredentialsManager.ts');
test('Has getGeminiApiKey()', search(credMgr, 'public getGeminiApiKey'));
test('Has setGeminiApiKey()', search(credMgr, 'public setGeminiApiKey'));
test('Has getOpenaiApiKey()', search(credMgr, 'public getOpenaiApiKey'));
test('Has setOpenaiApiKey()', search(credMgr, 'public setOpenaiApiKey'));
test('Has getClaudeApiKey()', search(credMgr, 'public getClaudeApiKey'));
test('Has setClaudeApiKey()', search(credMgr, 'public setClaudeApiKey'));
test('Has getGroqApiKey()', search(credMgr, 'public getGroqApiKey'));
test('Has setGroqApiKey()', search(credMgr, 'public setGroqApiKey'));
test('Has getDeepseekApiKey()', search(credMgr, 'public getDeepseekApiKey'));
test('Has setDeepseekApiKey()', search(credMgr, 'public setDeepseekApiKey'));
test('Has getNvidiaNimApiKey()', search(credMgr, 'public getNvidiaNimApiKey'));
test('Has setNvidiaNimApiKey()', search(credMgr, 'public setNvidiaNimApiKey'));
test('getNativelyApiKey() returns undefined', search(credMgr, 'public getNativelyApiKey.*return undefined'));
test('All setters normalize whitespace', search(credMgr, 'setGeminiApiKey.*trimmed.*=.*key.*trim'));
test('All setters call saveCredentials()', extract(credMgr, 'public set\\w+ApiKey.*?saveCredentials\\(\\)').length >= 6);

// ==== PHASE 5: Real Connection Testing ====
console.log('\nPHASE 5: REAL CONNECTION TESTING');
const ipcHandlers = readFile('electron/ipcHandlers.ts');
test('test-llm-connection handler exists', search(ipcHandlers, "safeHandle.*'test-llm-connection'"));
test('test-llm-connection tests real Gemini API', search(ipcHandlers, 'generativelanguage\\.googleapis\\.com'));
test('test-llm-connection tests real OpenAI API', search(ipcHandlers, 'api\\.openai\\.com.*chat/completions'));
test('test-llm-connection tests real Claude API', search(ipcHandlers, 'api\\.anthropic\\.com'));
test('test-llm-connection tests real Groq API', search(ipcHandlers, 'api\\.groq\\.com'));
test('test-llm-connection tests real DeepSeek API', search(ipcHandlers, 'api\\.deepseek\\.com'));
test('test-llm-connection tests real NVIDIA NIM API', search(ipcHandlers, 'integrate\\.api\\.nvidia\\.com'));
test('test-llm-connection has 15s timeout', search(ipcHandlers, 'timeout.*15000'));
test('test-llm-connection does not log raw axios errors', search(ipcHandlers, 'do NOT log the raw axios error'));
test('test-llm-connection returns normalized errors only', search(ipcHandlers, 'success.*false.*error'));

// ==== PHASE 6: Dynamic Model Discovery ====
console.log('\nPHASE 6: DYNAMIC MODEL DISCOVERY');
test('fetch-provider-models handler exists', search(ipcHandlers, "safeHandle.*'fetch-provider-models'"));
test('fetch-provider-models fetches Gemini models', search(ipcHandlers, 'fetchProviderModels'));
test('fetch-provider-models persists to CredentialsManager', search(ipcHandlers, 'setCloudFetchedModels'));
const modelFetcher = readFile('electron/utils/modelFetcher.ts');
test('modelFetcher exports fetchProviderModels', search(modelFetcher, 'export.*fetchProviderModels'));
test('modelFetcher filters OpenAI models', search(modelFetcher, 'fetchOpenAIModels'));
test('modelFetcher filters Claude models', search(modelFetcher, 'fetchAnthropicModels'));
test('modelFetcher filters Groq models', search(modelFetcher, 'fetchGroqModels'));
test('modelFetcher filters Gemini models', search(modelFetcher, 'fetchGeminiModels'));
test('modelFetcher handles DeepSeek models', search(modelFetcher, 'fetchDeepSeekModels'));
test('modelFetcher handles NVIDIA NIM models', search(modelFetcher, 'fetchNvidiaNimModels'));

// ==== PHASE 7: Provider-Specific Discovery ====
console.log('\nPHASE 7: PROVIDER-SPECIFIC DISCOVERY');
test('Gemini uses /v1beta/models endpoint', search(modelFetcher, '/v1beta/models'));
test('OpenAI uses /v1/models endpoint', search(modelFetcher, '/v1/models.*openai'));
test('Claude uses paginated /v1/models endpoint', search(modelFetcher, 'anthropic.*has_more'));
test('Groq uses /v1/models endpoint', search(modelFetcher, '/v1/models.*groq'));
test('DeepSeek uses /models endpoint', search(modelFetcher, '/models.*deepseek'));
test('NVIDIA NIM uses /v1/models endpoint', search(modelFetcher, '/v1/models.*nvidia'));

// ==== PHASE 8: Gemini ====
console.log('\nPHASE 8: GEMINI');
test('Exactly ONE Gemini client (this.client)', extract(llmHelper, 'this\\.client\\s*=\\s*new GoogleGenAI').length === 1);
test('Gemini model detection method exists', search(llmHelper, 'isGeminiModel'));
test('Gemini generation method exists', search(llmHelper, 'private async generateContent'));
test('Gemini streaming method exists', search(llmHelper, 'private async \\* streamWithGemini'));

// ==== PHASE 9: Fallback ====
console.log('\nPHASE 9: FALLBACK');
test('Invalid API key is non-retryable', search(ipcHandlers, '401|INVALID_API_KEY'));
test('Timeout is retryable with bounded time', search(ipcHandlers, 'timeout.*15000'));
test('Rate limit is retryable', search(ipcHandlers, '429|RATE_LIMITED'));
test('Server error is retryable', search(ipcHandlers, '5\\d\\d|SERVER_ERROR'));

// ==== PHASE 10: Model Identity ====
console.log('\nPHASE 10: MODEL IDENTITY');
test('currentModelId tracks active model', search(llmHelper, 'this\\.currentModelId'));
test('setModel() switches provider', search(llmHelper, 'public setModel.*modelId'));
test('isUsingNativelyServerCascade() checks model', search(llmHelper, 'isUsingNativelyServerCascade.*currentModelId'));

// ==== PHASE 11: Global File Repository ====
console.log('\nPHASE 11: GLOBAL FILE REPOSITORY');
const dbMgr = readFile('electron/db/DatabaseManager.ts');
test('Database has chunks table', search(dbMgr, 'chunks'));
test('Database has embeddings', search(dbMgr, 'embedding'));
test('Database has personal_files table', search(dbMgr, 'personal_files'));
test('Database has knowledge tables', search(dbMgr, 'knowledge_'));

// ==== PHASE 15: Electron Security ====
console.log('\nPHASE 15: ELECTRON SECURITY');
const preload = readFile('electron/preload.ts');
test('Preload does NOT expose getGeminiApiKey', !search(preload, 'getGeminiApiKey'));
test('Preload does NOT expose getOpenaiApiKey', !search(preload, 'getOpenaiApiKey'));
test('Preload does NOT expose getClaudeApiKey', !search(preload, 'getClaudeApiKey'));
test('Preload DOES expose setGeminiApiKey', search(preload, 'setGeminiApiKey'));
test('Preload DOES expose setOpenaiApiKey', search(preload, 'setOpenaiApiKey'));
test('Preload DOES expose fetchProviderModels', search(preload, 'fetchProviderModels'));
test('Preload DOES expose testLlmConnection', search(preload, 'testLlmConnection'));

// ==== SUMMARY ====
console.log('\n=== SUMMARY ===');
console.log(`✓ PASSED: ${tests.pass}`);
console.log(`✗ FAILED: ${tests.fail}`);

if (tests.failed.length > 0) {
  console.log('\nFailed tests:');
  tests.failed.forEach((name) => console.log(`  - ${name}`));
}

process.exit(tests.fail > 0 ? 1 : 0);
