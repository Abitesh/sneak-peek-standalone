import fs from 'fs';

const file = 'electron/IntelligenceEngine.ts';
const s = fs.readFileSync(file, 'utf8');

const old = `                                    const { appendCustomModeSystemPromptLayer } = require('./llm/documentGroundedPrompt');
                                    const { isCustomMode } = require('./services/ModesManager');
                                    const _activeModeRow = mm.getActiveMode?.();`;
const neu = `                                    const { appendCustomModeSystemPromptLayer } = require('./llm/documentGroundedPrompt');
                                    const { ModesManager, isCustomMode } = require('./services/ModesManager');
                                    const mm = ModesManager.getInstance();
                                    const _activeModeRow = mm.getActiveMode?.();`;

if (!s.includes(old)) {
  if (s.includes("const { ModesManager, isCustomMode } = require('./services/ModesManager');\n                                    const mm = ModesManager.getInstance();")) {
    console.log('Change 51 mm repair-prompt fix already present.');
    process.exit(0);
  }
  throw new Error('Change 51 mm repair-prompt target block not found.');
}

fs.writeFileSync(file, s.replace(old, neu));
console.log('Change 51 mm repair-prompt fix applied.');
