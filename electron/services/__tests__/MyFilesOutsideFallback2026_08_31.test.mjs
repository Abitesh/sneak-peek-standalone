import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ipc = readFileSync(path.join(root, 'ipcHandlers.ts'), 'utf8');
const composer = readFileSync(
  path.join(root, 'context-intelligence/generation/prompt-composer.ts'),
  'utf8',
);

test('manual-chat V3 counts My Files in attachedSourceCount (so file-miss falls back to general knowledge)', () => {
  assert.match(
    ipc,
    /attachedSourceCount:\s*files\.length\s*\+\s*personalFiles\.length/,
    'BUG: My Files must count as attached sources. Otherwise empty My Files retrieval hits the "nothing was searched" branch and the model refuses instead of answering from outside/general knowledge.',
  );
  assert.match(
    ipc,
    /personalFiles\.map\(\(f\) => f\.fileName\)/,
    'BUG: My Files names must be listed alongside mode attachments for the evidence narrative.',
  );
});

test('composer still licenses general knowledge when attached material does not cover the question', () => {
  assert.match(
    composer,
    /answer the question itself helpfully[\s\S]{0,40}from general knowledge/,
    'BUG: file-miss → outside/general-knowledge wording must remain when generalKnowledgeAllowed is true.',
  );
  assert.match(
    composer,
    /const generalKnowledgeAllowed = d\.generalKnowledgeAllowed/,
    'BUG: absence wording must honour the user Answer policy (option 1 = outside OK, option 2 = refuse).',
  );
});
