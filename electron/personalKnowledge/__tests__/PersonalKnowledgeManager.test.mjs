import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

test('Person 1 ingests, persists, searches, and deletes a text file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'person1-manager-'));
  const db = new Database(path.join(dir, 'test.db'));
  const filePath = path.join(dir, 'notes.md');
  fs.writeFileSync(filePath, '# Redis\nRedis caching improves API latency.\n\nPostgreSQL stores durable records.');

  try {
    const { PersonalKnowledgeManager } = await import('../../../dist-electron/electron/personalKnowledge/PersonalKnowledgeManager.js');
    PersonalKnowledgeManager.instance = null;
    const manager = PersonalKnowledgeManager.getInstance(db);
    const file = await manager.ingestFile(filePath);

    assert.equal(file.fileName, 'notes.md');
    assert.equal(file.sizeBytes > 0, true);
    assert.equal(file.chunkCount > 0, true);
    assert.equal(manager.listFiles().length, 1);

    const results = manager.search('Redis caching');
    assert.equal(results.length > 0, true);
    assert.match(results[0].text, /Redis caching/);
    assert.match(manager.buildPromptContext('Redis caching'), /<personal_file_knowledge>/);

    assert.equal(manager.deleteFile(file.id), true);
    assert.deepEqual(manager.listFiles(), []);
    assert.deepEqual(manager.search('Redis caching'), []);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM personal_file_chunks_fts').get().count, 0);
    assert.equal(manager.deleteFile(file.id), false);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Person 1 rejects oversized, empty, unsupported, and binary-mislabeled files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'person1-validation-'));
  const db = new Database(path.join(dir, 'test.db'));
  const oversizedPath = path.join(dir, 'large.txt');
  const emptyPath = path.join(dir, 'empty.txt');
  const binaryPath = path.join(dir, 'binary.txt');
  const unsupportedPath = path.join(dir, 'image.bin');
  fs.writeFileSync(oversizedPath, Buffer.alloc(25 * 1024 * 1024 + 1));
  fs.writeFileSync(emptyPath, '');
  fs.writeFileSync(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  fs.writeFileSync(unsupportedPath, 'not supported');

  try {
    const { PersonalKnowledgeManager } = await import('../../../dist-electron/electron/personalKnowledge/PersonalKnowledgeManager.js');
    PersonalKnowledgeManager.instance = null;
    const manager = PersonalKnowledgeManager.getInstance(db);
    await assert.rejects(() => manager.ingestFile(oversizedPath), /25 MB/);
    await assert.rejects(() => manager.ingestFile(emptyPath), /empty|readable text/);
    await assert.rejects(() => manager.ingestFile(binaryPath), /binary/);
    await assert.rejects(() => manager.ingestFile(unsupportedPath), /Unsupported file type/);
    assert.deepEqual(manager.listFiles(), []);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite FTS5 is available in the project runtime', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'person1-fts-'));
  const db = new Database(path.join(dir, 'test.db'));
  try {
    db.exec(`
      CREATE VIRTUAL TABLE person1_test_fts USING fts5(
        chunk_id UNINDEXED,
        text
      );
      INSERT INTO person1_test_fts(chunk_id, text)
      VALUES ('1', 'Redis caching and PostgreSQL database project');
    `);

    const row = db.prepare(
      `SELECT chunk_id FROM person1_test_fts WHERE person1_test_fts MATCH ?`,
    ).get('"Redis" OR "PostgreSQL"');

    assert.equal(row?.chunk_id, '1');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
