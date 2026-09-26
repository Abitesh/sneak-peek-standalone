import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve('electron/llm/WhatToAnswerLLM.ts');
if (!fs.existsSync(file)) throw new Error(`Missing ${file}`);

let s = fs.readFileSync(file, 'utf8');
const original = s;

// 1) Repair the exact brace removed by the first Change 48 script.
// The universal-RAG branch is itself inside the reference_files-allowed branch.
// After removing the legacy fallback, that outer `else { ... }` still needs its
// closing brace immediately before the OKF augmentation block.
const fixAnchor = '                        // Fix 1b (2026-07-06): augment the retrieved chunk block';
const fixIdx = s.indexOf(fixAnchor);
if (fixIdx < 0) throw new Error('Change 48 repair anchor not found: OKF augmentation block is missing.');
const beforeFix = s.slice(0, fixIdx);
const tail = beforeFix.slice(-260);
if (!/\n\s*}\s*\n\s*$/.test(tail)) {
  throw new Error('Unexpected WTA structure before OKF augmentation; refusing to guess.');
}
// Current broken file has only the `if (!universalModeRetrieved)` close here.
// A valid file needs the enclosing `else {` close as well.
const lastLines = beforeFix.split('\n').slice(-8).join('\n');
if (!lastLines.includes('no direct Mode retrieval fallback will run')) {
  throw new Error('Expected Change 48 universal-only marker not found immediately before repair point.');
}
if (!/no direct Mode retrieval fallback will run'\);\n\s*}\s*$/.test(lastLines)) {
  throw new Error('Change 48 universal-only block already has an unexpected shape; refusing to guess.');
}
s = s.slice(0, fixIdx) + '                        }\n\n' + s.slice(fixIdx);

// 2) Remove the obsolete application-level legacy retrieval type surface.
s = s.replace(/import type \{ ModeRetrievalOptions \} from "\.\.\/services\/ModeContextRetriever";\n/g, '');
s = s.replace(/\n\s*buildRetrievedActiveModeContextBlock: \(query: string, transcript\?: string, tokenBudget\?: number, answerType\?: AnswerType, excludeCustomContext\?: boolean, pinnedModeId\?: string, retrievalOptions\?: ModeRetrievalOptions\) => string;/g, '');
s = s.replace(/\n\s*\/\/ Phase 4: optional async hybrid retrieval \(FTS \+ vector\)\. Backwards\n\s*\/\/ compatible — older builds without this method still work via the\n\s*\/\/ sync lexical fallback\. `answerType` \(Phase 3\) scopes the mode's\n\s*\/\/ customContext so sensitive chunks can't leak into the wrong answer\.\n\s*buildRetrievedActiveModeContextBlockHybrid\?: \(query: string, transcript\?: string, tokenBudget\?: number, answerType\?: AnswerType, excludeCustomContext\?: boolean, pinnedModeId\?: string, allowRerank\?: boolean, retrievalOptions\?: ModeRetrievalOptions\) => Promise<string>;/g, '');

// 3) Scope denial must never route the denied reference layer back into ModesManager.
s = s.replace(/console\.warn\('\[ScopeFallback\] reference_files denied; local fallback available, routing via streamChat'\);\n\s*const retrievalQuery = retrievalQueryDecision\.query;\n\s*modeContextBlock = modesManager\.buildRetrievedActiveModeContextBlock\([^\n]+\);/g,
  "console.warn('[ScopeFallback] reference_files denied; reference context omitted at the source boundary');");

// 4) Do not leave the old direct retrieval helpers anywhere in WTA.
if (/buildRetrievedActiveModeContextBlockHybrid/.test(s)) throw new Error('Legacy hybrid retrieval helper still referenced in WTA.');
if (/buildRetrievedActiveModeContextBlock\s*\(/.test(s)) throw new Error('Legacy lexical retrieval helper still referenced in WTA.');
if (/ModeRetrievalOptions/.test(s)) throw new Error('Legacy ModeRetrievalOptions import/type still referenced in WTA.');
if (/reference_files denied; local fallback available, routing via streamChat/.test(s)) throw new Error('Scope-denial direct retrieval still present in WTA.');

if (s === original) throw new Error('Repair made no changes.');
fs.writeFileSync(file, s);
console.log(`Change 48 repair applied to ${file}`);
