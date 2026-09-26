import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const files = [
  'electron/llm/__tests__/suggestionPromptAssembly.test.mjs',
  'electron/llm/__tests__/WtaHybridRetrievalBudget.test.mjs',
].map(p => path.resolve(root, p));

for (const file of files) {
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}`);
}

const suggestion = fs.readFileSync(files[0], 'utf8');
const hybrid = fs.readFileSync(files[1], 'utf8');

const checks = [
  ['old legacy runtime assertion removed', !suggestion.includes('LEGACY path, pinned via kill-switch')],
  ['old v2 retrieval assertion removed', !suggestion.includes('default-on path')],
  ['universal legacy-regime test present', suggestion.includes('uses the universal RAG boundary for mode context')],
  ['universal v2 test present', suggestion.includes('v2 keeps universal retrieved context out of the system prompt')],
  ['universal RAG sentinel present', suggestion.includes('UNIVERSAL_REFERENCE_CONTEXT_SENTINEL')],
  ['hybrid latency test uses universal RAG', hybrid.includes('universal RAG retrieval is bounded')],
  ['fast universal result test present', hybrid.includes('fast universal RAG result directly')],
  ['no old hybrid expectation remains', !hybrid.includes('HYBRID_CONTEXT_FAST')],
  ['no old lexical expectation remains', !hybrid.includes('LEXICAL_FALLBACK_CONTEXT')],
];

let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
console.log('Change 49 test-convergence verification passed.');
