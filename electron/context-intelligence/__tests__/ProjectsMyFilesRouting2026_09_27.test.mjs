import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8');

test('Projects is a first-class My Files category', () => {
  const ui = read('src/components/settings/MyFilesPanel.tsx');
  const manager = read('electron/personalKnowledge/PersonalKnowledgeManager.ts');
  const types = read('src/types/electron.d.ts');

  for (const source of [ui, manager, types]) {
    assert.match(source, /'project'/);
  }
  assert.match(ui, /project:\s*['"]Projects['"]/);
  assert.match(manager, /PERSONAL_FILE_TYPES[^;]*project/);
});

test('persistent project files become PROJECT_FILE evidence', () => {
  const rag = read('electron/rag/RAGManager.ts');
  assert.match(rag, /fileType.*project.*PROJECT_FILE|PROJECT_FILE.*fileType.*project/s);
  assert.match(rag, /personalFileType.*PROJECT_FILE/);
});
