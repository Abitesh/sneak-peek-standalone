import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dbModulePath = path.join(repoRoot, 'dist-electron/electron/db/DatabaseManager.js');
let testUserData;
let dbm;

describe('local Notes database', () => {
  before(() => {
    testUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-notes-'));
    process.env.NATIVELY_TEST_USERDATA = testUserData;
    const { DatabaseManager } = require(dbModulePath);
    dbm = DatabaseManager.getInstance();
    assert.equal(dbm.isAvailable(), true, 'the isolated SQLite database should open');
  });

  after(() => {
    dbm?.close();
    if (testUserData) fs.rmSync(testUserData, { recursive: true, force: true });
    delete process.env.NATIVELY_TEST_USERDATA;
  });

  test('v38 creates the notes table on a fresh database', () => {
    const raw = dbm.getDb();
    assert.equal(raw.pragma('user_version', { simple: true }), 38);
    const columns = raw.prepare('PRAGMA table_info(notes)').all().map((row) => row.name);
    for (const column of ['id', 'title', 'content', 'created_at', 'updated_at']) {
      assert.ok(columns.includes(column), `notes.${column} missing`);
    }
    assert.deepEqual(dbm.listNotes(), []);
  });

  test('create/get/update preserve local notes and keep rows independent', () => {
    const first = dbm.createNote('  Linkship Interview  ');
    const second = dbm.createNote('DBMS');
    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first.id, second.id);
    assert.equal(first.title, 'Linkship Interview');
    assert.equal(first.content, '');

    const exactText = 'PostgreSQL\nRedis\nCelery\nDjango\nBase62\nGeoIP\nRedirect flow';
    const updated = dbm.updateNote(first.id, ' Linkship Interview ', exactText);
    assert.equal(updated?.title, 'Linkship Interview');
    assert.equal(updated?.content, exactText);
    assert.equal(dbm.getNote(first.id)?.content, exactText);
    assert.equal(dbm.getNote(second.id)?.content, '');

    const dbmsText = '1NF\n2NF\n3NF\nBCNF\nIndexing\nTransactions';
    assert.equal(dbm.updateNote(second.id, 'DBMS', dbmsText)?.content, dbmsText);
    assert.equal(dbm.getNote(first.id)?.content, exactText, 'updating DBMS must not overwrite Linkship');

    const raw = dbm.getDb();
    raw.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run('2026-09-28T12:00:00.000Z', first.id);
    raw.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run('2026-09-28T11:00:00.000Z', second.id);
    const newestFirst = dbm.listNotes();
    assert.deepEqual(newestFirst.map((note) => note.id), [first.id, second.id]);
  });

  test('blank titles are rejected and delete only removes the requested note', () => {
    const beforeCount = dbm.listNotes().length;
    assert.equal(dbm.createNote('   '), null);
    assert.equal(dbm.listNotes().length, beforeCount);
    const note = dbm.createNote('Disposable');
    assert.ok(note);
    assert.equal(dbm.deleteNote(note.id), true);
    assert.equal(dbm.getNote(note.id), null);
  });

  test('saved multiline content survives closing and reopening SQLite', () => {
    const note = dbm.createNote('Restart durability');
    assert.ok(note);
    const exactText = 'First line\nSecond line\nThird line';
    assert.equal(dbm.updateNote(note.id, note.title, exactText)?.content, exactText);
    dbm.close();

    const Database = require('better-sqlite3');
    const reopened = new Database(path.join(testUserData, 'natively.db'));
    try {
      const row = reopened.prepare('SELECT title, content FROM notes WHERE id = ?').get(note.id);
      assert.deepEqual(row, { title: 'Restart durability', content: exactText });
    } finally {
      reopened.close();
    }
  });

  test('IPC, renderer types, and Launcher expose Notes without routing to Modes from the four-box button', () => {
    const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
    const ipc = read('electron/ipcHandlers.ts');
    const preload = read('electron/preload.ts');
    const types = read('src/types/electron.d.ts');
    const launcher = read('src/components/Launcher.tsx');
    const notesPage = read('src/components/NotesPage.tsx');

    for (const channel of ['notes:list', 'notes:get', 'notes:create', 'notes:update', 'notes:delete']) {
      assert.ok(ipc.includes(channel), `missing ${channel} IPC handler`);
    }
    for (const method of ['notesList', 'notesGet', 'notesCreate', 'notesUpdate', 'notesDelete']) {
      assert.match(preload, new RegExp(`${method}:`));
      assert.match(types, new RegExp(`${method}:`));
    }
    const buttonStart = launcher.indexOf('data-testid="open-notes-page"');
    assert.ok(buttonStart >= 0, 'four-box launcher control should open Notes');
    const buttonEnd = launcher.indexOf('</button>', buttonStart);
    const button = launcher.slice(buttonStart, buttonEnd);
    assert.match(button, /setIsNotesOpen\(true\)/);
    assert.doesNotMatch(button, /onOpenModes/);
    assert.match(notesPage, /if \(!title\)/, 'empty note titles must be rejected in the renderer');
    assert.match(notesPage, /disabled=\{!newTitle\.trim\(\)\}/, 'Add stays disabled for an empty title');
  });
});