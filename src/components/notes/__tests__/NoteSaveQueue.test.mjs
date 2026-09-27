import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNoteSaveQueue } from '../noteSaveQueue.ts';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('a queued Note A save cannot overwrite Note B and newer A writes stay ordered', async () => {
  const gate = deferred();
  const writes = [];
  const save = createNoteSaveQueue(async (draft) => {
    if (draft.id === 'a' && draft.content === 'A old') await gate.promise;
    writes.push({ ...draft });
    return draft;
  });

  const oldA = save({ id: 'a', title: 'A', content: 'A old' });
  const newA = save({ id: 'a', title: 'A', content: 'A new' });
  const noteB = save({ id: 'b', title: 'B', content: 'B body' });
  assert.equal((await noteB).id, 'b');
  assert.deepEqual(writes, [{ id: 'b', title: 'B', content: 'B body' }]);

  gate.resolve();
  await Promise.all([oldA, newA]);
  assert.deepEqual(writes, [
    { id: 'b', title: 'B', content: 'B body' },
    { id: 'a', title: 'A', content: 'A old' },
    { id: 'a', title: 'A', content: 'A new' },
  ]);
});