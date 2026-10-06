import test from 'node:test';
import assert from 'node:assert/strict';
import { GenerationLifecycle } from '../GenerationController.js';

test('generation lifecycle enforces the canonical planning-to-completion order', () => {
  const lifecycle = new GenerationLifecycle('lifecycle-1');
  assert.equal(lifecycle.state, 'IDLE');

  lifecycle.transition('PLANNING', 'request accepted');
  lifecycle.transition('RETRIEVING', 'context selected');
  lifecycle.transition('GENERATING', 'provider stream started');
  lifecycle.transition('COMMITTED', 'first visible token');
  lifecycle.transition('COMPLETED', 'stream finished');

  assert.deepEqual(
    lifecycle.snapshot.history.map((entry) => entry.state),
    ['IDLE', 'PLANNING', 'RETRIEVING', 'GENERATING', 'COMMITTED', 'COMPLETED'],
  );
});

test('generation lifecycle rejects provider commit before generation', () => {
  const lifecycle = new GenerationLifecycle('lifecycle-2');
  lifecycle.transition('PLANNING');
  assert.throws(
    () => lifecycle.transition('COMMITTED'),
    /Invalid generation lifecycle transition: PLANNING -> COMMITTED/,
  );
});

test('generation lifecycle cancellation is terminal and records the reason', () => {
  const lifecycle = new GenerationLifecycle('lifecycle-3');
  lifecycle.transition('PLANNING');
  lifecycle.transition('RETRIEVING');
  lifecycle.cancel('newer generation superseded this request');

  assert.equal(lifecycle.state, 'CANCELLED');
  assert.equal(lifecycle.snapshot.history.at(-1).reason, 'newer generation superseded this request');
  assert.throws(() => lifecycle.transition('GENERATING'), /CANCELLED -> GENERATING/);
});

test('generation lifecycle can be cancelled after commit but never completed afterwards', () => {
  const lifecycle = new GenerationLifecycle('lifecycle-4');
  lifecycle.transition('PLANNING');
  lifecycle.transition('RETRIEVING');
  lifecycle.transition('GENERATING');
  lifecycle.transition('COMMITTED');
  lifecycle.cancel('STOP pressed');

  assert.equal(lifecycle.state, 'CANCELLED');
  assert.throws(() => lifecycle.transition('COMPLETED'), /CANCELLED -> COMPLETED/);
});
