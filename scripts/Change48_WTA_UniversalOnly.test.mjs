import fs from 'node:fs';

const file = 'electron/llm/WhatToAnswerLLM.ts';
const s = fs.readFileSync(file, 'utf8');

const checks = [
  ['WTA still has the injected RAG manager', /ragManagerProvider/.test(s)],
  ['WTA still calls the universal RAG boundary', /ragManager\.buildContext\(/.test(s)],
  ['normal direct Mode hybrid retrieval is retired', !/buildRetrievedActiveModeContextBlockHybrid/.test(s)],
  ['normal direct Mode lexical retrieval is retired', !/buildRetrievedActiveModeContextBlock\s*\(/.test(s)],
  ['legacy Mode retrieval type import is retired', !/ModeRetrievalOptions/.test(s)],
  ['governed EvidenceResolver may still use the lower-level raw retriever', /retrieveHybridRaw/.test(s)],
  ['scope denial no longer assigns denied reference context', !/reference_files denied; local fallback available, routing via streamChat[\s\S]*buildRetrievedActiveModeContextBlock/.test(s)],
  ['Change 48 outer reference-files branch is closed before OKF augmentation', /no direct Mode retrieval fallback will run'[\s\S]*?\n\s*}\s*\n\s*\/\/ Fix 1b/.test(s)],
];

let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
console.log('Change 48 repair static verification passed.');
