import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve('electron/llm/WhatToAnswerLLM.ts');
if (!fs.existsSync(file)) throw new Error(`Missing ${file}`);

let s = fs.readFileSync(file, 'utf8');
const original = s;

// Remove the normal (ungoverned) ModeHybridRetriever fallback from WTA.
const hybridPattern = /\n\s*if \(!universalModeRetrieved && typeof modesManager\.buildRetrievedActiveModeContextBlockHybrid === 'function'\) \{[\s\S]*?\n\s*\}\n\s*\}\n\s*if \(!modeContextBlock\) \{\n\s*\/\/ excludeCustomContext \(PI v3 W2\):[\s\S]*?\n\s*modeContextBlock = modesManager\.buildRetrievedActiveModeContextBlock\([^\n]+\);\n\s*\}\n/;
const hybridMatch = s.match(hybridPattern);
if (!hybridMatch) {
  throw new Error('Change 48 anchor not found: normal WTA Mode retrieval fallback block is missing or already migrated.');
}
const replacement = `\n                            // Change 48: WTA no longer bypasses the universal RAG boundary\n                            // when Mode retrieval is empty, times out, or fails. ModeRagAdapter\n                            // owns the legacy ModeContextRetriever/ModeHybridRetriever mechanics\n                            // behind RAGManager, so a second retrieval path here would duplicate\n                            // policy, ranking, and evidence handling.\n                            if (!universalModeRetrieved) {\n                                console.warn('[WhatToAnswerLLM] universal Mode RAG produced no usable evidence; no direct Mode retrieval fallback will run');\n                            }\n`;
s = s.replace(hybridPattern, replacement);

// Remove the provider-scope denial branch's direct Mode retrieval. If reference_files
// are denied, the answer proceeds without reference-file context; it must not silently
// retrieve the denied source through ModesManager.
const scopePattern = /\n\s*console\.warn\('\[ScopeFallback\] reference_files denied; local fallback available, routing via streamChat'\);\n\s*const retrievalQuery = retrievalQueryDecision\.query;\n\s*modeContextBlock = modesManager\.buildRetrievedActiveModeContextBlock\([^\n]+\);/;
const scopeMatch = s.match(scopePattern);
if (!scopeMatch) {
  throw new Error('Change 48 anchor not found: ScopeFallback direct Mode retrieval is missing or already migrated.');
}
s = s.replace(scopePattern, `\n                        console.warn('[ScopeFallback] reference_files denied; reference context omitted at the source boundary');`);

// Remove obsolete WTA type surface for the direct legacy retrieval helpers.
s = s.replace(/import type \{ ModeRetrievalOptions \} from "\.\.\/services\/ModeContextRetriever";\n/, '');
s = s.replace(/\n\s*buildRetrievedActiveModeContextBlock: \(query: string, transcript\?: string, tokenBudget\?: number, answerType\?: AnswerType, excludeCustomContext\?: boolean, pinnedModeId\?: string, retrievalOptions\?: ModeRetrievalOptions\) => string;/, '');
s = s.replace(/\n\s*\/\/ Phase 4: optional async hybrid retrieval \(FTS \+ vector\)\.[\s\S]*?\n\s*buildRetrievedActiveModeContextBlockHybrid\?: \(query: string, transcript\?: string, tokenBudget\?: number, answerType\?: AnswerType, excludeCustomContext\?: boolean, pinnedModeId\?: string, allowRerank\?: boolean, retrievalOptions\?: ModeRetrievalOptions\) => Promise<string>;/, '');

if (s === original) throw new Error('Change 48 made no changes.');
fs.writeFileSync(file, s);
console.log(`Change 48 applied to ${file}`);
