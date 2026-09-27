import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNoteSaveQueue } from './noteSaveQueue.ts';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('saves carry note ids; notes save independently and same-note writes stay ordered', async () => {
  const gate = deferred();
  const completed = [];
  const save = createNoteSaveQueue(async (draft) => {
    if (draft.id === 'note-a' && draft.content === 'A1') await gate.promise;
    completed.push(draft);
    return draft;
  });

  const firstA = save({ id: 'note-a', title: 'A', content: 'A1' });
  const secondA = save({ id: 'note-a', title: 'A', content: 'A2' });
  const saveB = save({ id: 'note-b', title: 'B', content: 'B1' });

  assert.equal((await saveB).id, 'note-b');
  assert.deepEqual(completed.map((draft) => draft.id), ['note-b']);
  gate.resolve();
  await Promise.all([firstA, secondA]);
  assert.deepEqual(completed.map(({ id, content }) => [id, content]), [
    ['note-b', 'B1'],
    ['note-a', 'A1'],
    ['note-a', 'A2'],
  ]);
});
