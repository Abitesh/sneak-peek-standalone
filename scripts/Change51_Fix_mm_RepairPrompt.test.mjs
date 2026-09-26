import fs from 'fs';

const file = 'electron/IntelligenceEngine.ts';
const s = fs.readFileSync(file, 'utf8');

const required = [
  "const { ModesManager, isCustomMode } = require('./services/ModesManager');",
  'const mm = ModesManager.getInstance();',
  'const _activeModeRow = mm.getActiveMode?.();',
  'modePromptSuffix: mm.getActiveModeSystemPromptSuffix?.(_activeModeRow?.id),',
  'pinnedInstructions: mm.getActiveModePinnedInstructions?.(answerPlan.answerType, _activeModeRow?.id),',
];

for (const needle of required) {
  if (!s.includes(needle)) throw new Error(`Missing expected Change 51 mm repair-prompt line: ${needle}`);
}

console.log('Change 51 mm repair-prompt verification passed.');
