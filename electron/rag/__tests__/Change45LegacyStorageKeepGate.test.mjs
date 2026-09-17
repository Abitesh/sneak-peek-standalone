// Change 45 keep-gate: do not remove legacy storage yet.
// Change 25 Phase 9D is NO-GO (docs/change-25-phase-9d-audit.md).
// This file is the gate, not a table drop. Dual-write and Mode status
// writers stay until backfill/shadow/parity/production validation.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const KEEP_TABLES = [
  'mode_reference_index_state',
  'mode_reference_chunks',
  'personal_file_chunks',
  'chunks',
  'rag_index_status',
];

const SCAN_FILES = [
  'electron/rag/RAGManager.ts',
  'electron/services/modes/ModeHybridRetriever.ts',
  'electron/personalKnowledge/PersonalKnowledgeManager.ts',
  'electron/rag/canonical/CanonicalRagIndexer.ts',
  'electron/db/DatabaseManager.ts',
];

// Exact table names only. vec_chunks / vec_summaries / vec_chunks_${dim}
// and DROP TABLE ${name} in the old vec0 cleanup must not trip this.
const LEGACY_DROP = new RegExp(
  String.raw`DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[\`'"]?(?:${KEEP_TABLES.join('|')})[\`'"]?(?![A-Za-z0-9_])`,
  'i',
);

test('keep-gate regex ignores existing vec0 DROPs and catches forbidden tables', () => {
  assert.equal(LEGACY_DROP.test('DROP TABLE IF EXISTS vec_chunks;'), false);
  assert.equal(LEGACY_DROP.test('DROP TABLE IF EXISTS vec_summaries;'), false);
  assert.equal(LEGACY_DROP.test('DROP TABLE IF EXISTS vec_chunks_${dim};'), false);
  assert.equal(LEGACY_DROP.test('this.db.exec(`DROP TABLE ${name};`)'), false);
  assert.equal(LEGACY_DROP.test('DROP TABLE embedding_queue_old;'), false);
  assert.equal(LEGACY_DROP.test('DROP TABLE mode_reference_index_state'), true);
  assert.equal(LEGACY_DROP.test('DROP TABLE IF EXISTS chunks;'), true);
  assert.equal(LEGACY_DROP.test('DROP TABLE rag_index_status'), true);
});

test('Change 45 does not DROP legacy RAG tables (Phase 9D NO-GO)', () => {
  for (const rel of SCAN_FILES) {
    const src = read(rel);
    const hit = src.match(LEGACY_DROP);
    assert.equal(hit, null, `${rel} must not DROP ${KEEP_TABLES.join(', ')}; found ${hit && hit[0]}`);
  }
});

test('ModeHybridRetriever still writes Mode index status', () => {
  const mode = read('electron/services/modes/ModeHybridRetriever.ts');
  assert.match(mode, /private updateIndexState\s*\(/);
  assert.match(mode, /private removeIndexState\s*\(/);
  assert.match(mode, /private ensureIndexTable\s*\(/);
  assert.match(mode, /INSERT OR REPLACE INTO mode_reference_index_state/);
  assert.match(mode, /DELETE FROM mode_reference_index_state/);
  assert.match(mode, /CREATE TABLE IF NOT EXISTS mode_reference_index_state/);
});

test('DatabaseManager still writes mode_reference_index_state', () => {
  const db = read('electron/db/DatabaseManager.ts');
  assert.match(db, /public updateModeReferenceIndexState\s*\(/);
  assert.match(db, /INSERT OR REPLACE INTO mode_reference_index_state/);
});

test('canonicalRagRead stays default off', () => {
  const flags = read('electron/intelligence/intelligenceFlags.ts');
  assert.match(
    flags,
    /canonicalRagRead:\s*\{[^}]*env:\s*'NATIVELY_CANONICAL_RAG_READ'[^}]*default:\s*false/,
  );
});

test('shouldWriteLegacyRagChunks stays the inverse of canonicalRagRead', () => {
  const flags = read('electron/intelligence/intelligenceFlags.ts');
  const start = flags.indexOf('export function shouldWriteLegacyRagChunks');
  assert.notEqual(start, -1, 'shouldWriteLegacyRagChunks must exist');
  const body = flags.slice(start, flags.indexOf('export function', start + 1));
  assert.match(body, /return !isIntelligenceFlagEnabled\('canonicalRagRead'\)/);
});
