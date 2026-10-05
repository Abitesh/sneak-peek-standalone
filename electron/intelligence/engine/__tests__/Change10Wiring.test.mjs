import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const engine = await fs.readFile(path.join(here, '..', 'NativelyIntelligenceEngine.ts'), 'utf8');
const types = await fs.readFile(path.join(here, '..', 'types.ts'), 'utf8');
const answerPlanner = await fs.readFile(path.resolve(here, '../../../llm/AnswerPlanner.ts'), 'utf8');
const normalizer = await fs.readFile(path.resolve(here, '../../OutputShapeNormalizer.ts'), 'utf8');
const wta = await fs.readFile(path.resolve(here, '../../../llm/WhatToAnswerLLM.ts'), 'utf8');

test('engine produces and returns the canonical ResponsePlan', () => {
  assert.match(engine, /import \{ planResponse \} from ['"]\.\/ResponsePlanner['"]/);
  assert.match(engine, /const responsePlan = planResponse\(/);
  assert.match(engine, /responsePlan,/);
  assert.match(types, /responsePlan: ResponsePlan/);
});

test('AnswerPlanner remains routing authority while exposing a response-shape seed', () => {
  assert.match(answerPlanner, /export type AnswerResponseShapeSeed/);
  assert.match(answerPlanner, /responseShapeSeedForAnswerType/);
  assert.match(answerPlanner, /responseShapeSeed:\s*responseShapeSeedForAnswerType\(answerType\)/);
});

test('legacy WTA path consumes the new response plan during migration', () => {
  assert.match(wta, /planResponse\(/);
  assert.match(wta, /formatResponsePlanForPrompt\(responsePlan\)/);
});

test('output normalization can consume ResponsePlan without breaking legacy callers', () => {
  assert.match(normalizer, /responsePlan\?: ResponsePlan/);
  assert.match(normalizer, /input\.responsePlan\?\.kind === 'coding'/);
  assert.match(normalizer, /input\.answerType \?\? input\.responsePlan\?\.answerType/);
});
