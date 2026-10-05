import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = await fs.readFile(path.join(here, '..', 'ResponsePlanner.ts'), 'utf8');

test('response planning is a separate stage from context selection', () => {
  assert.match(source, /export interface ResponsePlan/);
  assert.match(source, /export function planResponse/);
  assert.doesNotMatch(source, /RAGManager|RetrievalCoordinator|ContextPlanner/);
});

test('required answer-shape categories are represented', () => {
  for (const kind of [
    'direct-answer', 'explanation', 'project-grounded', 'first-person-interview',
    'coding', 'troubleshooting', 'example', 'summary',
  ]) {
    assert.match(source, new RegExp(`['"]${kind}['"]`));
  }
});

test('duration and detail are explicit response-plan fields', () => {
  assert.match(source, /requestedDurationSeconds/);
  assert.match(source, /explicitDurationSeconds/);
  assert.match(source, /detailLevel/);
  assert.match(source, /maxTokens/);
  assert.match(source, /maxSentences/);
  assert.match(source, /duration_is_user_requested/);
});

test('interview/project and coding examples have deterministic routing seeds', () => {
  assert.match(source, /project_about_answer/);
  assert.match(source, /project-grounded/);
  assert.match(source, /first-person-interview/);
  assert.match(source, /coding_question_answer/);
  assert.match(source, /debugging_question_answer/);
});
