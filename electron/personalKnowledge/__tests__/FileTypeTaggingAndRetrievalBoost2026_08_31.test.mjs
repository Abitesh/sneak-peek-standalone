// electron/personalKnowledge/__tests__/FileTypeTaggingAndRetrievalBoost2026_08_31.test.mjs
//
// Sprint S6 — File RAG + Context Manager (Problems 33-34, 46).
// Covers the two additive behaviors this sprint adds on top of the existing
// "My Files" lexical index: resume/job_description tagging + the retrieval
// boost it drives, and the honest per-file indexStatus the Context Manager UI
// now reads instead of a hardcoded "READY" badge.
//
// Run: npm run build:electron, then node --test on this file.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const load = () => import('../../../dist-electron/electron/personalKnowledge/PersonalKnowledgeManager.js');

test('file-type tagging boosts a tagged file above an equally-relevant untagged one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'person1-filetype-'));
  const db = new Database(path.join(dir, 'test.db'));
  const resumePath = path.join(dir, 'resume.txt');
  const notesPath = path.join(dir, 'notes.txt');
  // Same query-relevant body text (so any score difference comes from the
  // file-type boost, not lexical content) with distinct trailing tokens that
  // don't match the query — otherwise byte-identical files collapse into one
  // row via ingestFile's content-hash de-dup.
  const body = 'Backend engineer with distributed systems experience at scale.';
  fs.writeFileSync(resumePath, `${body}\n(resume copy)`);
  fs.writeFileSync(notesPath, `${body}\n(notes copy)`);

  try {
    const { PersonalKnowledgeManager } = await load();
    PersonalKnowledgeManager.instance = null;
    const manager = PersonalKnowledgeManager.getInstance(db);

    const resumeFile = await manager.ingestFile(resumePath);
    const notesFile = await manager.ingestFile(notesPath);
    assert.equal(resumeFile.fileType, 'general', 'ingestFile defaults untagged uploads to general');

    const tagged = manager.setFileType(resumeFile.id, 'resume');
    assert.equal(tagged.fileType, 'resume');

    const results = manager.search('backend engineer distributed systems');
    const resumeResult = results.find((r) => r.fileId === resumeFile.id);
    const notesResult = results.find((r) => r.fileId === notesFile.id);
    assert.ok(resumeResult, 'tagged file must still be found');
    assert.ok(notesResult, 'untagged file must still be found');
    assert.ok(
      resumeResult.score > notesResult.score,
      `resume-tagged file (${resumeResult.score}) should outscore the identical untagged file (${notesResult.score})`,
    );

    assert.throws(() => manager.setFileType(resumeFile.id, 'not-a-real-type'), /Invalid file type/);
    assert.throws(() => manager.setFileType('missing-id', 'resume'), /not found/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listFiles reports indexStatus: done for clean text, lexical_only for unrepaired binary chunks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'person1-status-'));
  const db = new Database(path.join(dir, 'test.db'));
  const cleanPath = path.join(dir, 'clean.txt');
  fs.writeFileSync(cleanPath, 'Plain readable text about project architecture.');

  try {
    const { PersonalKnowledgeManager } = await load();
    PersonalKnowledgeManager.instance = null;
    const manager = PersonalKnowledgeManager.getInstance(db);

    const clean = await manager.ingestFile(cleanPath);
    assert.equal(manager.getFile(clean.id).indexStatus, 'done');
    assert.equal(manager.listFiles()[0].indexStatus, 'done');

    // Simulate a file whose PDF/DOCX extraction failed and left raw binary
    // markers in its chunk text (the exact condition repairUnreadableIndexes
    // detects and retries).
    db.prepare(
      `UPDATE personal_file_chunks SET text = '%PDF-1.4 garbage binary' WHERE file_id = ?`,
    ).run(clean.id);
    db.prepare(
      `UPDATE personal_file_chunks_fts SET text = '%PDF-1.4 garbage binary' WHERE file_id = ?`,
    ).run(clean.id);

    assert.equal(manager.getFile(clean.id).indexStatus, 'lexical_only');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repairUnreadableIndexes is exposed publicly for the embedder-ready retry hook', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'person1-repair-'));
  const db = new Database(path.join(dir, 'test.db'));
  try {
    const { PersonalKnowledgeManager } = await load();
    PersonalKnowledgeManager.instance = null;
    const manager = PersonalKnowledgeManager.getInstance(db);
    assert.equal(typeof manager.repairUnreadableIndexes, 'function');
    const result = await manager.repairUnreadableIndexes();
    assert.equal(typeof result.repaired, 'number');
    assert.equal(typeof result.errors, 'number');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
