import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = await fs.readFile(path.join(here, '..', 'PromptAssembler.ts'), 'utf8');

test('PromptAssembler consumes ResponsePlan without deciding context', () => {
  assert.match(source, /import type \{ ResponsePlan \} from ['"]\.\/ResponsePlanner['"]/);
  assert.match(source, /responsePlan\?: ResponsePlan/);
  assert.match(source, /renderResponsePolicy\(input\.request, input\.responsePlan\)/);
  assert.match(source, /Follow this response shape after using the already-selected context/);
  assert.doesNotMatch(source, /new\s+ContextPlanner|new\s+RetrievalCoordinator/);
});

test('PromptAssembler preserves the Change 9 ConversationTurn text field', () => {
  assert.match(source, /turn\.text/);
  assert.doesNotMatch(source, /turn\.content/);
});
