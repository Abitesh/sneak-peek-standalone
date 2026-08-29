import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load the compiled DatabaseManager
async function loadDatabaseManager() {
  const modulePath = path.resolve(__dirname, '../../../dist-electron/electron/db/DatabaseManager.js');
  return import(`file://${modulePath}?v=${Date.now()}`);
}

describe('PersonalFiles database methods', () => {
  let db;

  test('setup: get DatabaseManager instance', async () => {
    const module = await loadDatabaseManager();
    db = module.DatabaseManager.getInstance();
    assert.ok(db, 'DatabaseManager should be initialized');
  });

  test('listPersonalFiles returns empty array initially', () => {
    const files = db.listPersonalFiles();
    assert.ok(Array.isArray(files), 'Should return an array');
  });

  test('insertPersonalFile stores a file', () => {
    const fileId = uuidv4();
    const result = db.insertPersonalFile(
      fileId,
      'test.txt',
      '/tmp/test.txt',
      'text/plain',
      100,
      'abc123hash'
    );
    assert.equal(result, true, 'Insert should succeed');

    const file = db.getPersonalFile(fileId);
    assert.ok(file, 'File should be retrievable');
    assert.equal(file.file_name, 'test.txt');
  });

  test('insertPersonalFileChunks stores and retrieves chunks', () => {
    const fileId = uuidv4();
    db.insertPersonalFile(fileId, 'test2.txt', '/tmp/test2.txt', 'text/plain', 200, 'hash2');

    const chunks = [
      { id: uuidv4(), chunkIndex: 0, text: 'Hello world', startChar: 0, endChar: 11 },
      { id: uuidv4(), chunkIndex: 1, text: 'Second chunk', startChar: 11, endChar: 23 },
    ];

    const result = db.insertPersonalFileChunks(fileId, chunks);
    assert.equal(result, true, 'Chunk insertion should succeed');

    const retrieved = db.getPersonalFileChunks(fileId);
    assert.equal(retrieved.length, 2, 'Should retrieve both chunks');
    assert.equal(retrieved[0].text, 'Hello world');
  });

  test('deletePersonalFile removes file and chunks', () => {
    const fileId = uuidv4();
    db.insertPersonalFile(fileId, 'test3.txt', '/tmp/test3.txt', 'text/plain', 300, 'hash3');
    db.insertPersonalFileChunks(fileId, [
      { id: uuidv4(), chunkIndex: 0, text: 'Content', startChar: 0, endChar: 7 },
    ]);

    const result = db.deletePersonalFile(fileId);
    assert.equal(result, true, 'Deletion should succeed');

    const file = db.getPersonalFile(fileId);
    assert.ok(!file, 'File should be deleted');

    const chunks = db.getPersonalFileChunks(fileId);
    assert.equal(chunks.length, 0, 'Chunks should be deleted via cascade');
  });

  test('clearPersonalFileChunks removes chunks but keeps file', () => {
    const fileId = uuidv4();
    db.insertPersonalFile(fileId, 'test4.txt', '/tmp/test4.txt', 'text/plain', 400, 'hash4');
    db.insertPersonalFileChunks(fileId, [
      { id: uuidv4(), chunkIndex: 0, text: 'Content', startChar: 0, endChar: 7 },
    ]);

    const result = db.clearPersonalFileChunks(fileId);
    assert.equal(result, true, 'Clear chunks should succeed');

    const chunks = db.getPersonalFileChunks(fileId);
    assert.equal(chunks.length, 0, 'Chunks should be cleared');

    const file = db.getPersonalFile(fileId);
    assert.ok(file, 'File should still exist');
  });
});
