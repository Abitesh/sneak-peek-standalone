import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUnifiedRagSettingEnabled,
  unifiedRagSettingKeys,
  unifiedRagSettingMeta,
  isUnifiedRagSettingEnvForced,
  __resetIntelligenceFlagsCache,
} from '../../../dist-electron/electron/intelligence/intelligenceFlags.js';

const ENV = [
  'NATIVELY_RAG_ENABLED',
  'NATIVELY_RAG_HYBRID_ENABLED',
  'NATIVELY_RAG_RERANK_ENABLED',
  'NATIVELY_RAG_CONFIDENCE_GATE_ENABLED',
  'NATIVELY_RAG_CITATIONS_ENABLED',
  'NATIVELY_RAG_CONVERSATION_AWARE_ENABLED',
  'NATIVELY_RAG_LOCAL_RERANK',
  'NATIVELY_RAG_CONFIDENCE_GATE',
];

function clearEnv() {
  for (const key of ENV) delete process.env[key];
  __resetIntelligenceFlagsCache();
}

beforeEach(clearEnv);
afterEach(clearEnv);

test('Change 21 exposes exactly six canonical RAG settings', () => {
  assert.deepEqual(unifiedRagSettingKeys(), [
    'ragEnabled',
    'ragHybridEnabled',
    'ragRerankEnabled',
    'ragConfidenceGateEnabled',
    'ragCitationsEnabled',
    'ragConversationAwareEnabled',
  ]);
});

test('canonical RAG settings preserve current defaults', () => {
  assert.equal(isUnifiedRagSettingEnabled('ragEnabled'), true);
  assert.equal(isUnifiedRagSettingEnabled('ragHybridEnabled'), true);
  assert.equal(isUnifiedRagSettingEnabled('ragCitationsEnabled'), true);
  assert.equal(isUnifiedRagSettingEnabled('ragConversationAwareEnabled'), true);
  assert.equal(isUnifiedRagSettingEnabled('ragRerankEnabled'), false);
  assert.equal(isUnifiedRagSettingEnabled('ragConfidenceGateEnabled'), false);
});

test('new canonical env overrides legacy compatibility flags', () => {
  process.env.NATIVELY_RAG_LOCAL_RERANK = '1';
  process.env.NATIVELY_RAG_RERANK_ENABLED = '0';
  assert.equal(isUnifiedRagSettingEnabled('ragRerankEnabled'), false);

  process.env.NATIVELY_RAG_CONFIDENCE_GATE = '0';
  process.env.NATIVELY_RAG_CONFIDENCE_GATE_ENABLED = '1';
  assert.equal(isUnifiedRagSettingEnabled('ragConfidenceGateEnabled'), true);
});

test('legacy flags remain valid compatibility fallbacks', () => {
  process.env.NATIVELY_RAG_LOCAL_RERANK = '1';
  process.env.NATIVELY_RAG_CONFIDENCE_GATE = '1';
  assert.equal(isUnifiedRagSettingEnabled('ragRerankEnabled'), true);
  assert.equal(isUnifiedRagSettingEnabled('ragConfidenceGateEnabled'), true);
  assert.equal(unifiedRagSettingMeta('ragRerankEnabled').legacy, 'ragLocalRerank');
  assert.equal(unifiedRagSettingMeta('ragConfidenceGateEnabled').legacy, 'ragConfidenceGate');
});

test('environment forcing is reported for canonical and legacy mappings', () => {
  process.env.NATIVELY_RAG_ENABLED = '0';
  assert.equal(isUnifiedRagSettingEnvForced('ragEnabled'), true);
  process.env.NATIVELY_RAG_ENABLED = '';
  process.env.NATIVELY_RAG_LOCAL_RERANK = '1';
  assert.equal(isUnifiedRagSettingEnvForced('ragRerankEnabled'), true);
});
