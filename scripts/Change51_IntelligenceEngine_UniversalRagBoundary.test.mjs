import fs from 'node:fs';
import assert from 'node:assert/strict';

const s = fs.readFileSync('electron/IntelligenceEngine.ts','utf8');
assert.match(s,/private async retrieveUniversalModeContext\(/);
assert.match(s,/selectedSources:\s*\['mode-reference'\]/);
assert.match(s,/allowedSources:\s*\['mode-reference'\]/);
assert.match(s,/modeId:\s*modeId \?\? undefined/);
assert.match(s,/excludeCustomContext:\s*true/);
assert.match(s,/ragManager\.search\(query/);
assert.match(s,/this\.retrieveUniversalModeContext\(wtaPrefetchQuery/);
assert.match(s,/this\.retrieveUniversalModeContext\(docQuestion/);
assert.doesNotMatch(s,/buildRetrievedActiveModeContextBlockHybrid\(/);
assert.doesNotMatch(s,/buildRetrievedActiveModeContextBlock\(/);
// Governed V3 EvidenceResolver wiring remains intentionally raw-hybrid.
assert.match(s,/modesManager\.retrieveHybridRaw\(mode, files, options\)/);
console.log('Change 51 verification passed.');
