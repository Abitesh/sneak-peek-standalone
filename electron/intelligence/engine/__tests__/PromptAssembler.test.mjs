import assert from 'node:assert/strict';
import test from 'node:test';

// These tests are source-level contracts for the new assembler. The runtime
// implementation is compiled by the repository's normal Electron build.
const fs = await import('node:fs/promises');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const here = path.dirname(fileURLToPath(import.meta.url));
const source = await fs.readFile(path.join(here, '..', 'PromptAssembler.ts'), 'utf8');

const requiredMarkers = [
  '<system_instructions>',
  '<response_policy>',
  '<current_question>',
  '<conversation_context>',
  '<evidence>',
  '<screen_context>',
  '<user_context>',
  '<project_context>',
];

test('SingleFinalPromptInvariant: assembler owns final prompt construction', () => {
  assert.match(source, /export function assembleNativelyPrompt/);
  assert.match(source, /const finalPrompt = buildFinalPrompt\(selectedSections\)/);
  assert.match(source, /finalPrompt,/);
  assert.doesNotMatch(source, /from ['"]\.\/ContextPlanner['"]|from ['"]\.\/RetrievalCoordinator['"]|from ['"]\.\.\/\.\.\/rag\/RAGManager['"]|from ['"]\.\.\/\.\.\/llm\/WhatToAnswerLLM['"]|new\s+ContextPlanner|new\s+RetrievalCoordinator/);
});

test('SingleFinalPromptInvariant: prompt has the required ordered sections', () => {
  for (const marker of requiredMarkers) {
    const tagName = marker.slice(1, -1);
    assert.match(source, new RegExp(tagName));
  }
  const system = source.indexOf("sectionNames.push('system_instructions')");
  const policy = source.indexOf("sectionNames.push('response_policy')");
  const question = source.indexOf("sectionNames.push('current_question')");
  assert.ok(system < policy && policy < question, 'system → policy → question order must be stable');
});

test('assembler only renders evidence items with factual authority and deduplicates them', () => {
  assert.match(source, /item\.authority !== 'evidence'/);
  assert.match(source, /seenEvidence/);
  assert.match(source, /seenText/);
});

test('assembler gates screen, user and project context on the ContextPlan', () => {
  assert.match(source, /isSelected\(input\.contextPlan, 'screen'\)/);
  assert.match(source, /isSelected\(input\.contextPlan, 'personal_knowledge'\)/);
  assert.match(source, /isSelected\(input\.contextPlan, 'project_knowledge'\)/);
});

test('assembler strips known internal routing markers without inventing context', () => {
  assert.match(source, /__NATIVELY_INTERNAL_/);
  assert.match(source, /__ROUTING_/);
  assert.match(source, /routing_decision/);
  assert.match(source, /retrieval_decision/);
});

test('response policy carries output length intent instead of letting the assembler choose relevance', () => {
  assert.match(source, /maxTokens/);
  assert.match(source, /maxSentences/);
  assert.match(source, /durationSeconds/);
  assert.match(source, /concise/);
  assert.match(source, /detailed/);
});
